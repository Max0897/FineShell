use serde_json::{json, Map, Value};

use crate::agent::{AgentActionIntent, AgentActionRisk};

pub(crate) const MAX_FILE_EDIT_CHARS: usize = 60_000;
pub(crate) const MAX_TERMINAL_COMMAND_CHARS: usize = 4_096;
pub(crate) const MAX_COMMAND_PURPOSE_CHARS: usize = 240;

fn parse_arguments(arguments: &str) -> Result<Map<String, Value>, String> {
    let Value::Object(arguments) =
        serde_json::from_str(arguments).map_err(|_| "AI 动作参数不是有效 JSON".to_string())?
    else {
        return Err("AI 动作参数必须是对象".to_string());
    };
    Ok(arguments)
}

fn exact_keys(arguments: &Map<String, Value>, keys: &[&str]) -> bool {
    arguments.len() == keys.len() && keys.iter().all(|key| arguments.contains_key(*key))
}

pub(crate) fn normalize_remote_action_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.chars().count() > 1_024 || path.chars().any(char::is_control)
    {
        return Err("AI 文件动作必须使用有效的远程绝对路径".to_string());
    }
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| matches!(*segment, "." | ".."))
    {
        return Err("AI 文件动作路径不能包含相对路径片段".to_string());
    }
    if segments.is_empty() {
        return Err("禁止对远程根目录执行 AI 文件动作".to_string());
    }
    Ok(format!("/{}", segments.join("/")))
}

fn valid_content(content: &str) -> bool {
    content.chars().count() <= MAX_FILE_EDIT_CHARS && !content.contains('\0')
}

fn valid_command(command: &str) -> bool {
    let command = command.trim();
    !command.is_empty()
        && command.chars().count() <= MAX_TERMINAL_COMMAND_CHARS
        && !command.chars().any(|character| {
            character == '\r' || character == '\n' || (character.is_control() && character != '\t')
        })
}

fn normalize_purpose(purpose: &str) -> Result<String, String> {
    let purpose = purpose.split_whitespace().collect::<Vec<_>>().join(" ");
    if purpose.is_empty()
        || purpose.chars().count() > MAX_COMMAND_PURPOSE_CHARS
        || purpose.chars().any(char::is_control)
    {
        return Err("AI 命令用途无效".to_string());
    }
    Ok(purpose)
}

fn intent(
    id: &str,
    tool: &str,
    arguments: Value,
    reason: String,
    expected_effect: &str,
    risk: AgentActionRisk,
) -> Result<Option<AgentActionIntent>, String> {
    if id.trim().is_empty() || id.chars().count() > 160 {
        return Err("AI 动作标识无效".to_string());
    }
    Ok(Some(AgentActionIntent {
        id: id.to_string(),
        tool: tool.to_string(),
        arguments,
        reason,
        expected_effect: expected_effect.to_string(),
        risk,
    }))
}

pub(crate) fn proposal_action_intent(
    id: &str,
    tool: &str,
    raw_arguments: &str,
) -> Result<Option<AgentActionIntent>, String> {
    if !matches!(
        tool,
        "propose_file_edit" | "propose_file_operation" | "propose_terminal_command"
    ) {
        return Ok(None);
    }
    let arguments = parse_arguments(raw_arguments)?;
    match tool {
        "propose_file_edit" => {
            if !exact_keys(&arguments, &["path", "content"]) {
                return Err("AI 文件修改动作参数无效".to_string());
            }
            let path = normalize_remote_action_path(
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 文件修改路径无效".to_string())?,
            )?;
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .filter(|content| valid_content(content))
                .ok_or_else(|| "AI 文件修改内容无效".to_string())?;
            intent(
                id,
                tool,
                json!({ "path": path, "content": content }),
                format!("修改远程文件 {path}"),
                "完整替换指定远程文件的内容",
                AgentActionRisk::ReversibleWrite,
            )
        }
        "propose_file_operation" => {
            let operation = arguments
                .get("operation")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 文件操作类型无效".to_string())?;
            let path = normalize_remote_action_path(
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 文件操作路径无效".to_string())?,
            )?;
            match operation {
                "create" => {
                    if !exact_keys(&arguments, &["operation", "path", "content"]) {
                        return Err("AI 新建文件动作参数无效".to_string());
                    }
                    let content = arguments
                        .get("content")
                        .and_then(Value::as_str)
                        .filter(|content| valid_content(content))
                        .ok_or_else(|| "AI 新建文件内容无效".to_string())?;
                    intent(
                        id,
                        tool,
                        json!({ "operation": operation, "path": path, "content": content }),
                        format!("新建远程文件 {path}"),
                        "在当前远程目录创建文件",
                        AgentActionRisk::ReversibleWrite,
                    )
                }
                "rename" => {
                    if !exact_keys(&arguments, &["operation", "path", "target_path"]) {
                        return Err("AI 重命名文件动作参数无效".to_string());
                    }
                    let target_path = normalize_remote_action_path(
                        arguments
                            .get("target_path")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "AI 重命名目标路径无效".to_string())?,
                    )?;
                    if target_path == path {
                        return Err("AI 重命名目标不能与源文件相同".to_string());
                    }
                    intent(
                        id,
                        tool,
                        json!({
                            "operation": operation,
                            "path": path,
                            "targetPath": target_path,
                        }),
                        format!("将远程文件 {path} 重命名为 {target_path}"),
                        "在原目录内重命名远程文件",
                        AgentActionRisk::ReversibleWrite,
                    )
                }
                "delete" => {
                    if !exact_keys(&arguments, &["operation", "path"]) {
                        return Err("AI 删除文件动作参数无效".to_string());
                    }
                    intent(
                        id,
                        tool,
                        json!({ "operation": operation, "path": path }),
                        format!("删除远程文件 {path}"),
                        "删除指定远程文件",
                        AgentActionRisk::Elevated,
                    )
                }
                _ => Err("AI 文件操作类型无效".to_string()),
            }
        }
        "propose_terminal_command" => {
            if !exact_keys(&arguments, &["command", "purpose"]) {
                return Err("AI 终端命令动作参数无效".to_string());
            }
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .filter(|command| valid_command(command))
                .map(str::trim)
                .ok_or_else(|| "AI 终端命令无效".to_string())?;
            let purpose = normalize_purpose(
                arguments
                    .get("purpose")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 命令用途无效".to_string())?,
            )?;
            intent(
                id,
                tool,
                json!({ "command": command, "purpose": purpose }),
                purpose,
                "在当前终端会话中填入并执行命令",
                AgentActionRisk::Elevated,
            )
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::proposal_action_intent;
    use crate::agent::AgentActionRisk;

    #[test]
    fn creates_normalized_file_and_command_intents() {
        let edit = proposal_action_intent(
            "edit-1",
            "propose_file_edit",
            r#"{"path":"/etc//nginx.conf","content":"server {}"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(edit.arguments["path"], "/etc/nginx.conf");
        assert_eq!(edit.risk, AgentActionRisk::ReversibleWrite);

        let rename = proposal_action_intent(
            "rename-1",
            "propose_file_operation",
            r#"{"operation":"rename","path":"/tmp/a","target_path":"/tmp/b"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(rename.arguments["targetPath"], "/tmp/b");
        assert_eq!(rename.risk, AgentActionRisk::ReversibleWrite);

        let command = proposal_action_intent(
            "command-1",
            "propose_terminal_command",
            r#"{"command":"  systemctl status nginx  ","purpose":"检查  nginx   状态"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            command.arguments,
            json!({
                "command": "systemctl status nginx",
                "purpose": "检查 nginx 状态",
            })
        );
        assert_eq!(command.risk, AgentActionRisk::Elevated);
    }

    #[test]
    fn classifies_delete_as_elevated_and_ignores_diagnostics() {
        let delete = proposal_action_intent(
            "delete-1",
            "propose_file_operation",
            r#"{"operation":"delete","path":"/tmp/old.log"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(delete.risk, AgentActionRisk::Elevated);
        assert!(
            proposal_action_intent("status-1", "get_server_status", "{}")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_actions() {
        for arguments in [
            r#"{"operation":"delete","path":"/"}"#,
            r#"{"operation":"delete","path":"/tmp/../etc/passwd"}"#,
            r#"{"operation":"rename","path":"/tmp/a","target_path":"/tmp/a"}"#,
        ] {
            assert!(
                proposal_action_intent("operation-1", "propose_file_operation", arguments).is_err()
            );
        }
        assert!(proposal_action_intent(
            "command-1",
            "propose_terminal_command",
            r#"{"command":"echo ok\necho unsafe","purpose":"测试"}"#,
        )
        .is_err());
    }
}
