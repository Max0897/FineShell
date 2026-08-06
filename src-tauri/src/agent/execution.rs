use super::*;

impl AgentTaskManager {
    pub(crate) fn validate_action_execution_context(
        &self,
        task_id: &str,
        action_id: &str,
    ) -> Result<String, String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let tasks = self.lock_tasks()?;
        let task = tasks
            .get(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if !task.actions.iter().any(|action| action.id == action_id) {
            return Err("AI 动作不存在".to_string());
        }
        Ok(task.validate_execution_context()?.to_string())
    }

    pub(crate) fn authorize_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        user_confirmed: bool,
        content_override: Option<String>,
    ) -> Result<(AuthorizedAgentAction, Vec<AgentTaskEvent>), String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let (mut execution, approval_mode, risk, host_id, current_directory) = {
            let tasks = self.lock_tasks()?;
            let task = tasks
                .get(task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let action = task
                .actions
                .iter()
                .find(|action| action.id == action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let execution_kind = if action.tool == "execute_terminal_command" {
                AgentActionExecutionKind::TerminalCommand
            } else {
                AgentActionExecutionKind::TrustedExecutor
            };
            if rollback && execution_kind == AgentActionExecutionKind::TerminalCommand {
                return Err("终端命令不能通过文件回滚流程撤销".to_string());
            }
            if rollback {
                if action.status != AgentActionStatus::Succeeded {
                    return Err("AI 动作当前不能回滚".to_string());
                }
            } else if execution_kind == AgentActionExecutionKind::TerminalCommand {
                if action.status != AgentActionStatus::Pending {
                    return Err("AI 命令当前不能再次审批".to_string());
                }
            } else if !matches!(
                action.status,
                AgentActionStatus::Pending | AgentActionStatus::Approved
            ) {
                return Err("AI 动作当前不能执行".to_string());
            }
            let session_id = task
                .terminal_session_id
                .clone()
                .ok_or_else(|| "AI 动作缺少绑定会话".to_string())?;
            (
                AuthorizedAgentAction {
                    task_id: task_id.to_string(),
                    action_id: action_id.to_string(),
                    tool: action.tool.clone(),
                    arguments: action.arguments.clone(),
                    session_id,
                    host_id: task.host_id.clone(),
                    current_directory: task.current_directory.clone(),
                    rollback,
                    execution_kind,
                },
                task.approval_mode,
                action.risk,
                task.host_id.clone(),
                task.current_directory.clone(),
            )
        };
        let has_content_override = if let Some(content) = content_override {
            if rollback || execution.tool != "propose_file_edit" {
                return Err("只有待应用的文件修改可以调整最终内容".to_string());
            }
            if content.len() > MAX_AGENT_WRITABLE_FILE_BYTES || content.contains('\0') {
                return Err("AI 文件修改的最终内容无效".to_string());
            }
            let original = execution
                .arguments
                .get("originalContent")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "AI 文件修改缺少可信原始快照".to_string())?;
            if content == original {
                return Err("AI 文件修改没有产生变化".to_string());
            }
            execution.arguments["content"] = serde_json::Value::String(content);
            true
        } else {
            false
        };
        let policy = registered_action_policy(approval_mode, &execution.tool, risk);
        match policy.decision {
            PolicyDecision::Deny => return Err(policy.reason),
            PolicyDecision::Prompt if !user_confirmed => {
                return Err("该 AI 动作需要本次用户审批".to_string());
            }
            PolicyDecision::Allow | PolicyDecision::Prompt => {}
        }
        if policy.decision == PolicyDecision::Prompt {
            let direction = if rollback { "rollback" } else { "apply" };
            let fingerprint_arguments = serde_json::json!({
                "arguments": execution.arguments,
                "direction": direction,
            });
            let scope = ApprovalScope {
                task_id: task_id.to_string(),
                plan_id: format!("action:{action_id}:{direction}"),
                call_id: action_id.to_string(),
                host_id,
                session_id: Some(execution.session_id.clone()),
                current_directory,
                action_fingerprint: action_fingerprint(&execution.tool, &fingerprint_arguments)?,
            };
            let mut credentials = self
                .approval_credentials
                .lock()
                .map_err(|_| "AI 审批凭证状态不可用".to_string())?;
            let credential =
                credentials.issue(scope.clone(), timestamp_ms(), APPROVAL_CREDENTIAL_TTL_MS)?;
            credentials.consume(&credential, &scope, timestamp_ms())?;
        }
        if has_content_override {
            let mut tasks = self.lock_tasks()?;
            let action = tasks
                .get_mut(task_id)
                .and_then(|task| {
                    task.actions
                        .iter_mut()
                        .find(|action| action.id == action_id)
                })
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            action.arguments = execution.arguments.clone();
        }
        let transition = if rollback {
            AgentActionTransition::RollbackStart
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand {
            AgentActionTransition::Approve
        } else {
            AgentActionTransition::Start
        };
        let summary = if rollback {
            "用户确认回滚该动作"
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand
            && policy.decision == PolicyDecision::Allow
        {
            "审批策略允许执行终端命令"
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand {
            "用户批准终端命令"
        } else if policy.decision == PolicyDecision::Allow {
            "审批策略允许执行该动作"
        } else {
            "用户批准执行该动作"
        };
        let events = self.transition_action(AgentActionTransitionRequest {
            task_id: task_id.to_string(),
            action_id: action_id.to_string(),
            transition,
            summary: Some(summary.to_string()),
            error: None,
        })?;
        Ok((execution, events))
    }
}
