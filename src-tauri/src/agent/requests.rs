use super::*;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentPlanDecisionKind {
    Approve,
    Reject,
    Stop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPlanDecisionRequest {
    pub(super) task_id: String,
    pub(super) plan_id: String,
    pub(super) decision: AgentPlanDecisionKind,
    #[serde(default)]
    pub(super) feedback: Option<String>,
    #[serde(default)]
    pub(super) selected_call_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentActionTransition {
    Approve,
    Reject,
    Start,
    Succeed,
    Conflict,
    Fail,
    RollbackStart,
    RolledBack,
    Retry,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionTransitionRequest {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) transition: AgentActionTransition,
    pub(crate) summary: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentTaskRecoveryDecision {
    ContinueAnalysis,
    Retry,
    Finish,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AgentTaskRecoveryRequest {
    pub(crate) task_id: String,
    pub(crate) decision: AgentTaskRecoveryDecision,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskRecoveryContext {
    pub(crate) previous_task_id: String,
    pub(crate) host_id: String,
    pub(crate) decision: AgentTaskRecoveryDecision,
    pub(crate) objective: String,
    pub(crate) interruption_reason: String,
    pub(crate) completed_actions: Vec<String>,
    pub(crate) uncertain_actions: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentCommandObservationPhase {
    Submitted,
    Completed,
    Unavailable,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AgentCommandObservationRequest {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) host_id: String,
    pub(crate) session_id: String,
    pub(crate) submission_id: String,
    pub(crate) phase: AgentCommandObservationPhase,
    pub(crate) command: String,
    pub(crate) exit_code: Option<u16>,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorizedAgentAction {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) tool: String,
    pub(crate) arguments: serde_json::Value,
    pub(crate) session_id: String,
    pub(crate) host_id: String,
    pub(crate) current_directory: Option<String>,
    pub(crate) rollback: bool,
    pub(crate) execution_kind: AgentActionExecutionKind,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AgentActionExecutionKind {
    TrustedExecutor,
    TerminalCommand,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingBusinessVerification {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) session_id: String,
    pub(crate) verification: AgentBusinessVerification,
}

pub(crate) fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_AGENT_ID_CHARS
}

pub(crate) fn remote_parent_path(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &path[..index],
    }
}

pub(crate) fn bounded_action_message(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > MAX_AGENT_ACTION_MESSAGE_CHARS {
        return Err("AI 动作结果说明过长".to_string());
    }
    Ok(Some(value))
}
