use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    agent::{
        emit_task_events, AgentActionTransition, AgentActionTransitionRequest, AgentTaskManager,
        AgentTrustedVerification, AuthorizedAgentAction,
    },
    protocol::{CommandError, CommandResult},
    sftp::{
        agent_apply_file_operation, agent_write_text_file, AiSftpFileOperationKind,
        AiSftpFileOperationRequest, SftpSessionManager, SftpTextFile,
    },
    ssh::SshSessionManager,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AgentActionExecutionRequest {
    task_id: String,
    action_id: String,
    #[serde(default)]
    rollback: bool,
    user_confirmed: bool,
    content_override: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionExecutionResult {
    action_id: String,
    action_type: &'static str,
    file: Option<SftpTextFile>,
    affected_paths: Vec<String>,
    #[serde(skip)]
    verification: Option<AgentTrustedVerification>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FileEditArguments {
    path: String,
    content: String,
    original_content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FileOperationArguments {
    operation: AiSftpFileOperationKind,
    path: String,
    target_path: Option<String>,
    content: Option<String>,
    expected_content: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalCommandArguments {
    command: String,
    purpose: String,
}

fn parse_arguments<T: for<'de> Deserialize<'de>>(
    action: &AuthorizedAgentAction,
) -> Result<T, String> {
    serde_json::from_value(action.arguments.clone())
        .map_err(|_| "AI 动作的可信执行参数无效".to_string())
}

fn operation_request(
    arguments: &FileOperationArguments,
    rollback: bool,
) -> Result<AiSftpFileOperationRequest, String> {
    if !rollback {
        return Ok(AiSftpFileOperationRequest {
            operation: arguments.operation,
            path: arguments.path.clone(),
            target_path: arguments.target_path.clone(),
            content: arguments.content.clone(),
            expected_content: arguments.expected_content.clone(),
        });
    }
    match arguments.operation {
        AiSftpFileOperationKind::Create => Ok(AiSftpFileOperationRequest {
            operation: AiSftpFileOperationKind::Delete,
            path: arguments.path.clone(),
            target_path: None,
            content: None,
            expected_content: arguments.content.clone(),
        }),
        AiSftpFileOperationKind::Rename => Ok(AiSftpFileOperationRequest {
            operation: AiSftpFileOperationKind::Rename,
            path: arguments
                .target_path
                .clone()
                .ok_or_else(|| "AI 重命名动作缺少可信目标路径".to_string())?,
            target_path: Some(arguments.path.clone()),
            content: None,
            expected_content: arguments.expected_content.clone(),
        }),
        AiSftpFileOperationKind::Delete => Ok(AiSftpFileOperationRequest {
            operation: AiSftpFileOperationKind::Create,
            path: arguments.path.clone(),
            target_path: None,
            content: arguments.expected_content.clone(),
            expected_content: None,
        }),
    }
}

async fn execute_action(
    action: &AuthorizedAgentAction,
    sftp_manager: SftpSessionManager,
    ssh_manager: SshSessionManager,
) -> Result<AgentActionExecutionResult, String> {
    match action.tool.as_str() {
        "propose_file_edit" => {
            let arguments: FileEditArguments = parse_arguments(action)?;
            let (content, original_content) = if action.rollback {
                (arguments.original_content, arguments.content)
            } else {
                (arguments.content, arguments.original_content)
            };
            let file = agent_write_text_file(
                sftp_manager,
                action.session_id.clone(),
                arguments.path.clone(),
                content,
                original_content,
            )
            .await?;
            Ok(AgentActionExecutionResult {
                action_id: action.action_id.clone(),
                action_type: "file_edit",
                file: Some(file),
                affected_paths: vec![arguments.path],
                verification: Some(AgentTrustedVerification::RemoteContentMatch),
            })
        }
        "propose_file_operation" => {
            let arguments: FileOperationArguments = parse_arguments(action)?;
            let request = operation_request(&arguments, action.rollback)?;
            let result =
                agent_apply_file_operation(sftp_manager, action.session_id.clone(), request)
                    .await?;
            let verification = if result.file.is_some() {
                AgentTrustedVerification::RemoteContentMatch
            } else {
                AgentTrustedVerification::RemotePathState
            };
            let mut affected_paths = vec![arguments.path];
            if let Some(target_path) = arguments.target_path {
                affected_paths.push(target_path);
            }
            Ok(AgentActionExecutionResult {
                action_id: action.action_id.clone(),
                action_type: "file_operation",
                file: result.file,
                affected_paths,
                verification: Some(verification),
            })
        }
        "propose_terminal_command" => {
            let arguments: TerminalCommandArguments = parse_arguments(action)?;
            let _ = arguments.purpose;
            ssh_manager.write(&action.session_id, arguments.command.into_bytes())?;
            Ok(AgentActionExecutionResult {
                action_id: action.action_id.clone(),
                action_type: "terminal_command",
                file: None,
                affected_paths: Vec::new(),
                verification: None,
            })
        }
        _ => Err("AI 动作不在可信执行注册表中".to_string()),
    }
}

fn is_conflict(error: &str) -> bool {
    error.contains("远程文件已被其他程序修改") || error.contains("远程目标已存在")
}

#[tauri::command]
pub(crate) async fn ai_task_action_execute(
    app: AppHandle,
    task_manager: State<'_, AgentTaskManager>,
    sftp_manager: State<'_, SftpSessionManager>,
    ssh_manager: State<'_, SshSessionManager>,
    request: AgentActionExecutionRequest,
) -> CommandResult<AgentActionExecutionResult> {
    let operation = "ai_task_action_execute";
    let (action, events) = task_manager
        .authorize_action_execution(
            &request.task_id,
            &request.action_id,
            request.rollback,
            request.user_confirmed,
            request.content_override,
        )
        .map_err(|error| CommandError::from_message(operation, error))?;
    emit_task_events(&app, events);
    match execute_action(
        &action,
        sftp_manager.inner().clone(),
        ssh_manager.inner().clone(),
    )
    .await
    {
        Ok(result) => {
            if !action.prepares_command {
                let verification = result.verification.ok_or_else(|| {
                    CommandError::from_message(operation, "AI 动作缺少可信验证结果")
                })?;
                let events = task_manager
                    .complete_trusted_action_execution(
                        &action.task_id,
                        &action.action_id,
                        action.rollback,
                        verification,
                    )
                    .map_err(|error| CommandError::from_message(operation, error))?;
                emit_task_events(&app, events);
            }
            Ok(result)
        }
        Err(error) => {
            let transition = if is_conflict(&error) {
                AgentActionTransition::Conflict
            } else {
                AgentActionTransition::Fail
            };
            if let Ok(events) = task_manager.transition_action(AgentActionTransitionRequest {
                task_id: action.task_id,
                action_id: action.action_id,
                transition,
                summary: None,
                error: Some(error.clone()),
            }) {
                emit_task_events(&app, events);
            }
            Err(CommandError::from_message(operation, error))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{operation_request, FileOperationArguments};
    use crate::sftp::AiSftpFileOperationKind;

    fn arguments(operation: AiSftpFileOperationKind) -> FileOperationArguments {
        FileOperationArguments {
            operation,
            path: "/srv/source.conf".to_string(),
            target_path: Some("/srv/target.conf".to_string()),
            content: Some("created".to_string()),
            expected_content: Some("original".to_string()),
        }
    }

    #[test]
    fn derives_inverse_file_operations_from_private_arguments() {
        let create = operation_request(&arguments(AiSftpFileOperationKind::Create), true).unwrap();
        assert_eq!(create.operation, AiSftpFileOperationKind::Delete);
        assert_eq!(create.expected_content.as_deref(), Some("created"));

        let rename = operation_request(&arguments(AiSftpFileOperationKind::Rename), true).unwrap();
        assert_eq!(rename.operation, AiSftpFileOperationKind::Rename);
        assert_eq!(rename.path, "/srv/target.conf");
        assert_eq!(rename.target_path.as_deref(), Some("/srv/source.conf"));

        let delete = operation_request(&arguments(AiSftpFileOperationKind::Delete), true).unwrap();
        assert_eq!(delete.operation, AiSftpFileOperationKind::Create);
        assert_eq!(delete.content.as_deref(), Some("original"));
        assert_eq!(
            serde_json::to_value(delete.content).unwrap(),
            json!("original")
        );
    }
}
