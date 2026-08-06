use std::collections::HashSet;

use serde_json::Value;

use crate::agent::{AgentActionRisk, AgentApprovalMode};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PolicyDecision {
    Allow,
    Prompt,
    Deny,
}

#[derive(Clone, Debug)]
pub(crate) struct PolicyEvaluation {
    pub(crate) decision: PolicyDecision,
    pub(crate) risk: AgentActionRisk,
    pub(crate) reason: String,
}

#[derive(Clone, Copy)]
struct ToolDescriptor {
    risk: AgentActionRisk,
    reversible: bool,
    bounded: bool,
    requires_session: bool,
    requires_network_target: bool,
}

fn diagnostic_descriptor(tool: &str) -> Option<ToolDescriptor> {
    let passive = ToolDescriptor {
        risk: AgentActionRisk::ReadOnly,
        reversible: false,
        bounded: true,
        requires_session: true,
        requires_network_target: false,
    };
    match tool {
        "get_server_status"
        | "list_processes"
        | "get_network_connections"
        | "inspect_service"
        | "read_service_logs" => Some(passive),
        "get_current_directory" => Some(ToolDescriptor {
            requires_session: false,
            ..passive
        }),
        "ping_target" | "trace_route" => Some(ToolDescriptor {
            risk: AgentActionRisk::Elevated,
            reversible: false,
            bounded: true,
            requires_session: true,
            requires_network_target: true,
        }),
        _ => None,
    }
}

fn valid_network_target(target: &str) -> bool {
    let target = target.trim();
    !target.is_empty()
        && target.len() <= 253
        && !target.starts_with('-')
        && target.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':')
        })
}

fn policy_decision(
    mode: AgentApprovalMode,
    risk: AgentActionRisk,
    reversible: bool,
    bounded: bool,
) -> PolicyDecision {
    match risk {
        AgentActionRisk::ReadOnly => PolicyDecision::Allow,
        AgentActionRisk::LowRisk => match mode {
            AgentApprovalMode::OnRequest => PolicyDecision::Prompt,
            AgentApprovalMode::AutoSafe | AgentApprovalMode::FullAccess => PolicyDecision::Allow,
        },
        AgentActionRisk::ReversibleWrite => match mode {
            AgentApprovalMode::OnRequest => PolicyDecision::Prompt,
            AgentApprovalMode::AutoSafe => PolicyDecision::Prompt,
            AgentApprovalMode::FullAccess if reversible && bounded => PolicyDecision::Allow,
            AgentApprovalMode::FullAccess => PolicyDecision::Prompt,
        },
        AgentActionRisk::Elevated => match mode {
            AgentApprovalMode::FullAccess if bounded => PolicyDecision::Allow,
            AgentApprovalMode::OnRequest
            | AgentApprovalMode::AutoSafe
            | AgentApprovalMode::FullAccess => PolicyDecision::Prompt,
        },
        AgentActionRisk::Critical => PolicyDecision::Deny,
    }
}

pub(crate) fn registered_action_policy(
    mode: AgentApprovalMode,
    tool: &str,
    risk: AgentActionRisk,
) -> PolicyEvaluation {
    let descriptor = match (tool, risk) {
        ("propose_file_edit", AgentActionRisk::ReversibleWrite) => Some((true, true)),
        ("propose_file_operation", AgentActionRisk::ReversibleWrite) => Some((true, true)),
        ("propose_file_operation", AgentActionRisk::Elevated) => Some((true, true)),
        ("execute_terminal_command", AgentActionRisk::LowRisk) => Some((false, true)),
        ("execute_terminal_command", AgentActionRisk::Elevated) => Some((false, true)),
        _ => None,
    };
    let Some((reversible, bounded)) = descriptor else {
        return PolicyEvaluation {
            decision: PolicyDecision::Deny,
            risk: AgentActionRisk::Critical,
            reason: "动作工具或风险等级不在后端注册表中".to_string(),
        };
    };
    let decision = policy_decision(mode, risk, reversible, bounded);
    let reason = match decision {
        PolicyDecision::Allow => "当前审批模式允许执行该动作",
        PolicyDecision::Prompt => "该动作需要本次用户审批",
        PolicyDecision::Deny => "当前策略拒绝该动作",
    };
    PolicyEvaluation {
        decision,
        risk,
        reason: reason.to_string(),
    }
}

pub(crate) struct ExecutionBoundary {
    task_id: String,
    host_id: String,
    session_id: Option<String>,
    current_directory: Option<String>,
    allowed_tools: HashSet<String>,
}

impl ExecutionBoundary {
    pub(crate) fn new(
        task_id: &str,
        host_id: &str,
        session_id: Option<&str>,
        current_directory: Option<&str>,
        allowed_tools: &HashSet<String>,
    ) -> Self {
        Self {
            task_id: task_id.to_string(),
            host_id: host_id.to_string(),
            session_id: session_id.map(str::to_string),
            current_directory: current_directory.map(str::to_string),
            allowed_tools: allowed_tools.clone(),
        }
    }

    pub(crate) fn evaluate(
        &self,
        mode: AgentApprovalMode,
        tool: &str,
        arguments: &Value,
    ) -> PolicyEvaluation {
        let Some(descriptor) = diagnostic_descriptor(tool) else {
            return PolicyEvaluation {
                decision: PolicyDecision::Deny,
                risk: AgentActionRisk::Critical,
                reason: "工具不在后端注册表中".to_string(),
            };
        };
        let boundary_error = if self.task_id.trim().is_empty() || self.host_id.trim().is_empty() {
            Some("任务或主机边界无效")
        } else if !self.allowed_tools.contains(tool) {
            Some("工具能力未在当前任务中启用")
        } else if descriptor.requires_session
            && self.session_id.as_deref().is_none_or(str::is_empty)
        {
            Some("工具需要绑定当前 SSH 会话")
        } else if tool == "get_current_directory"
            && self
                .current_directory
                .as_deref()
                .is_none_or(|path| !path.starts_with('/'))
        {
            Some("当前目录不在任务边界中")
        } else if descriptor.requires_network_target
            && !arguments
                .get("target")
                .and_then(Value::as_str)
                .is_some_and(valid_network_target)
        {
            Some("网络目标不在允许的参数边界中")
        } else {
            None
        };
        if let Some(reason) = boundary_error {
            return PolicyEvaluation {
                decision: PolicyDecision::Deny,
                risk: descriptor.risk,
                reason: reason.to_string(),
            };
        }

        let decision = policy_decision(
            mode,
            descriptor.risk,
            descriptor.reversible,
            descriptor.bounded,
        );
        let reason = match decision {
            PolicyDecision::Allow => "动作位于当前执行边界内，策略允许执行",
            PolicyDecision::Prompt => "动作需要用户审批后执行",
            PolicyDecision::Deny => "策略拒绝该动作",
        };
        PolicyEvaluation {
            decision,
            risk: descriptor.risk,
            reason: reason.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;

    use super::{policy_decision, registered_action_policy, ExecutionBoundary, PolicyDecision};
    use crate::agent::{AgentActionRisk, AgentApprovalMode};

    #[test]
    fn applies_the_complete_mode_and_risk_matrix() {
        let cases = [
            (
                AgentActionRisk::ReadOnly,
                PolicyDecision::Allow,
                PolicyDecision::Allow,
                PolicyDecision::Allow,
            ),
            (
                AgentActionRisk::LowRisk,
                PolicyDecision::Prompt,
                PolicyDecision::Allow,
                PolicyDecision::Allow,
            ),
            (
                AgentActionRisk::ReversibleWrite,
                PolicyDecision::Prompt,
                PolicyDecision::Prompt,
                PolicyDecision::Allow,
            ),
            (
                AgentActionRisk::Elevated,
                PolicyDecision::Prompt,
                PolicyDecision::Prompt,
                PolicyDecision::Allow,
            ),
            (
                AgentActionRisk::Critical,
                PolicyDecision::Deny,
                PolicyDecision::Deny,
                PolicyDecision::Deny,
            ),
        ];
        for (risk, on_request, auto_safe, full_access) in cases {
            assert_eq!(
                policy_decision(AgentApprovalMode::OnRequest, risk, true, true),
                on_request
            );
            assert_eq!(
                policy_decision(AgentApprovalMode::AutoSafe, risk, true, true),
                auto_safe
            );
            assert_eq!(
                policy_decision(AgentApprovalMode::FullAccess, risk, true, true),
                full_access
            );
        }
        assert_eq!(
            policy_decision(
                AgentApprovalMode::AutoSafe,
                AgentActionRisk::ReversibleWrite,
                false,
                true,
            ),
            PolicyDecision::Prompt
        );
    }

    #[test]
    fn denies_actions_outside_the_immutable_execution_boundary() {
        let tools = HashSet::from(["ping_target".to_string()]);
        let boundary = ExecutionBoundary::new(
            "task-1",
            "host-1",
            Some("session-1"),
            Some("/srv/app"),
            &tools,
        );
        assert_eq!(
            boundary
                .evaluate(
                    AgentApprovalMode::OnRequest,
                    "get_server_status",
                    &json!({}),
                )
                .decision,
            PolicyDecision::Deny
        );
        assert_eq!(
            boundary
                .evaluate(
                    AgentApprovalMode::FullAccess,
                    "ping_target",
                    &json!({ "target": "example.com; reboot" }),
                )
                .decision,
            PolicyDecision::Deny
        );
    }

    #[test]
    fn active_network_probes_follow_the_selected_mode() {
        let tools = HashSet::from(["ping_target".to_string()]);
        let boundary = ExecutionBoundary::new("task-1", "host-1", Some("session-1"), None, &tools);
        assert_eq!(
            boundary
                .evaluate(
                    AgentApprovalMode::OnRequest,
                    "ping_target",
                    &json!({ "target": "example.com" }),
                )
                .decision,
            PolicyDecision::Prompt
        );
        assert_eq!(
            boundary
                .evaluate(
                    AgentApprovalMode::FullAccess,
                    "ping_target",
                    &json!({ "target": "example.com" }),
                )
                .decision,
            PolicyDecision::Allow
        );
    }

    #[test]
    fn auto_safe_uses_command_risk_instead_of_file_reversibility() {
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::AutoSafe,
                "propose_file_edit",
                AgentActionRisk::ReversibleWrite,
            )
            .decision,
            PolicyDecision::Prompt
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::AutoSafe,
                "execute_terminal_command",
                AgentActionRisk::LowRisk,
            )
            .decision,
            PolicyDecision::Allow
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::AutoSafe,
                "execute_terminal_command",
                AgentActionRisk::Elevated,
            )
            .decision,
            PolicyDecision::Prompt
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::FullAccess,
                "propose_file_operation",
                AgentActionRisk::Elevated,
            )
            .decision,
            PolicyDecision::Allow
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::FullAccess,
                "execute_terminal_command",
                AgentActionRisk::Elevated,
            )
            .decision,
            PolicyDecision::Allow
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::FullAccess,
                "propose_terminal_command",
                AgentActionRisk::Elevated,
            )
            .decision,
            PolicyDecision::Deny
        );
    }

    #[test]
    fn arbitrary_shell_cannot_enter_the_controlled_execution_registry() {
        let tools = HashSet::from(["get_server_status".to_string(), "execute_shell".to_string()]);
        let boundary = ExecutionBoundary::new(
            "task-1",
            "host-1",
            Some("session-1"),
            Some("/srv/app"),
            &tools,
        );
        assert_eq!(
            boundary
                .evaluate(AgentApprovalMode::FullAccess, "execute_shell", &json!({}))
                .decision,
            PolicyDecision::Deny
        );
        assert_eq!(
            registered_action_policy(
                AgentApprovalMode::FullAccess,
                "propose_terminal_command",
                AgentActionRisk::Elevated,
            )
            .decision,
            PolicyDecision::Deny
        );
    }
}
