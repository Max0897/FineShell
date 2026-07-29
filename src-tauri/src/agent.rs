use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

use crate::agent_actions::{normalize_remote_action_path, valid_command};
use crate::agent_approvals::{
    action_fingerprint, ApprovalCredential, ApprovalCredentialStore, ApprovalScope,
};
use crate::agent_policy::{registered_action_policy, PolicyDecision};
use crate::agent_verification::{
    AgentBusinessVerification, AgentBusinessVerificationKind, AgentBusinessVerificationResult,
};
use crate::protocol::{CommandError, CommandResult, AGENT_TASK_EVENT, PROTOCOL_VERSION};

const MAX_AGENT_TASKS: usize = 100;
const MAX_AGENT_ID_CHARS: usize = 160;
const MAX_AGENT_OBJECTIVE_CHARS: usize = 24_000;
const MAX_AGENT_ACTIONS: usize = 24;
const MAX_AGENT_ACTION_MESSAGE_CHARS: usize = 500;
const MAX_AGENT_WRITABLE_FILES: usize = 8;
const MAX_AGENT_WRITABLE_FILE_BYTES: usize = 256 * 1024;
const MAX_AGENT_WRITABLE_FILES_BYTES: usize = 512 * 1024;
const MAX_OBSERVED_COMMAND_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const APPROVAL_CREDENTIAL_TTL_MS: u64 = 10 * 60 * 1_000;
const MAX_AGENT_REPAIR_ATTEMPTS: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentApprovalMode {
    OnRequest,
    AutoSafe,
    FullAccess,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AgentTaskStatus {
    Understanding,
    GatheringContext,
    Planning,
    Running,
    AwaitingApproval,
    AwaitingUserInput,
    Verifying,
    Paused,
    PausedDisconnected,
    Completed,
    Failed,
    Cancelled,
}

impl AgentTaskStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentPlanStatus {
    Pending,
    Running,
    Completed,
    Partial,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPlanStep {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) tool: String,
    pub(crate) status: AgentPlanStepStatus,
    pub(crate) detail: Option<String>,
    pub(crate) reason: String,
    pub(crate) optional: bool,
    pub(crate) depends_on: Vec<String>,
    pub(crate) summary: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) started_at: Option<u64>,
    pub(crate) duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPlan {
    pub(crate) id: String,
    pub(crate) description: Option<String>,
    pub(crate) status: AgentPlanStatus,
    pub(crate) created_at: u64,
    pub(crate) steps: Vec<AgentPlanStep>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AgentActionRisk {
    ReadOnly,
    ReversibleWrite,
    Elevated,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionIntent {
    pub(crate) id: String,
    pub(crate) tool: String,
    pub(crate) arguments: serde_json::Value,
    pub(crate) reason: String,
    pub(crate) expected_effect: String,
    pub(crate) risk: AgentActionRisk,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AgentWritableFile {
    path: String,
    content: String,
    size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentActionStatus {
    Pending,
    Approved,
    Running,
    Succeeded,
    Conflict,
    Failed,
    Rejected,
    RollingBack,
    RolledBack,
    RollbackConflict,
    RollbackFailed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentVerificationStatus {
    Pending,
    Verified,
    Partial,
    Unverified,
    Failed,
    NotApplicable,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRepairStopReason {
    VerificationFailed,
    ActionFailed,
    RepairBudgetExhausted,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRecoveryRecommendation {
    Rollback,
    Retry,
    ManualReview,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRecoveryStatus {
    Suggested,
    Running,
    Verified,
    Unverified,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRecoveryState {
    recommendation: AgentRecoveryRecommendation,
    status: AgentRecoveryStatus,
    summary: String,
    updated_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentVerificationEvidenceKind {
    RemoteContentMatch,
    RemotePathState,
    RecoveryStateMatch,
    CommandExitStatus,
    ServiceStatus,
    PortListening,
    ConfigSyntax,
    ResultUnavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentVerificationEvidence {
    kind: AgentVerificationEvidenceKind,
    summary: String,
    observed_at: u64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AgentTrustedVerification {
    RemoteContentMatch,
    RemotePathState,
}

impl AgentActionStatus {
    fn is_unresolved(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Approved | Self::Running | Self::RollingBack
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionState {
    id: String,
    tool: String,
    reason: String,
    expected_effect: String,
    risk: AgentActionRisk,
    status: AgentActionStatus,
    summary: Option<String>,
    error: Option<String>,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    duration_ms: Option<u64>,
    verification_status: AgentVerificationStatus,
    verification_evidence: Vec<AgentVerificationEvidence>,
    recovery_state: Option<AgentRecoveryState>,
    #[serde(skip_serializing)]
    arguments: serde_json::Value,
    #[serde(skip_serializing)]
    command_submission_id: Option<String>,
}

impl AgentActionState {
    fn from_intent(intent: AgentActionIntent) -> Self {
        Self {
            id: intent.id,
            tool: intent.tool,
            arguments: intent.arguments,
            reason: intent.reason,
            expected_effect: intent.expected_effect,
            risk: intent.risk,
            status: AgentActionStatus::Pending,
            summary: None,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            verification_status: AgentVerificationStatus::Pending,
            verification_evidence: Vec::new(),
            recovery_state: None,
            command_submission_id: None,
        }
    }

    fn record_verification(
        &mut self,
        status: AgentVerificationStatus,
        kind: AgentVerificationEvidenceKind,
        summary: impl Into<String>,
        observed_at: u64,
    ) {
        self.verification_status = status;
        self.verification_evidence.push(AgentVerificationEvidence {
            kind,
            summary: summary.into(),
            observed_at,
        });
    }

    fn update_recovery(
        &mut self,
        recommendation: AgentRecoveryRecommendation,
        status: AgentRecoveryStatus,
        summary: impl Into<String>,
        updated_at: u64,
    ) {
        self.recovery_state = Some(AgentRecoveryState {
            recommendation,
            status,
            summary: summary.into(),
            updated_at,
        });
    }

    fn suggest_repair(&mut self, retry_available: bool, updated_at: u64) {
        let can_rollback = self.status == AgentActionStatus::Succeeded
            && matches!(
                self.tool.as_str(),
                "propose_file_edit" | "propose_file_operation"
            );
        let (recommendation, summary) = if can_rollback {
            (
                AgentRecoveryRecommendation::Rollback,
                "业务验证未通过，建议回滚到动作执行前的远端状态",
            )
        } else if retry_available {
            (
                AgentRecoveryRecommendation::Retry,
                "建议修正动作参数后重试，并重新执行目标验证",
            )
        } else {
            (
                AgentRecoveryRecommendation::ManualReview,
                "修复预算已耗尽，建议人工检查远端状态",
            )
        };
        self.update_recovery(
            recommendation,
            AgentRecoveryStatus::Suggested,
            summary,
            updated_at,
        );
    }

    fn finish_repair_verification(&mut self, verified: bool, updated_at: u64) {
        let Some(recovery) = self.recovery_state.as_mut() else {
            return;
        };
        if recovery.status != AgentRecoveryStatus::Running {
            return;
        }
        recovery.status = if verified {
            AgentRecoveryStatus::Verified
        } else {
            AgentRecoveryStatus::Unverified
        };
        recovery.summary = if verified {
            "修复后的目标状态已经验证".to_string()
        } else {
            "修复动作已结束，但缺少可信的目标状态验证".to_string()
        };
        recovery.updated_at = updated_at;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskResult {
    summary: String,
    verified: bool,
    verification_status: AgentVerificationStatus,
    stop_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskContext {
    id: String,
    conversation_id: String,
    host_id: String,
    terminal_session_id: Option<String>,
    current_directory: Option<String>,
    #[serde(default)]
    file_operation_directory: Option<String>,
    #[serde(default)]
    writable_files: Vec<AgentWritableFile>,
    objective: String,
    approval_mode: AgentApprovalMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTask {
    id: String,
    conversation_id: String,
    host_id: String,
    terminal_session_id: Option<String>,
    current_directory: Option<String>,
    #[serde(skip_serializing)]
    file_operation_directory: Option<String>,
    #[serde(skip_serializing)]
    writable_files: Vec<AgentWritableFile>,
    approval_mode: AgentApprovalMode,
    status: AgentTaskStatus,
    objective: String,
    plan: Option<AgentPlan>,
    active_step_id: Option<String>,
    actions: Vec<AgentActionState>,
    model_completed: bool,
    iteration: u32,
    repair_attempts: u8,
    repair_limit: u8,
    repair_stop_reason: Option<AgentRepairStopReason>,
    last_event_sequence: u64,
    result: Option<AgentTaskResult>,
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentTaskEventKind {
    TaskCreated,
    ModelTurnStarted,
    ModelTurnCompleted,
    PlanCreated,
    PlanStarted,
    PlanUpdated,
    PlanCompleted,
    ActionProposed,
    ActionApproved,
    ActionRejected,
    ActionStarted,
    ActionSucceeded,
    ActionConflicted,
    ActionFailed,
    ActionRollbackStarted,
    ActionRolledBack,
    ActionRollbackConflicted,
    ActionRollbackFailed,
    ActionRetried,
    ActionVerificationRecorded,
    TaskPaused,
    TaskResumed,
    TaskCompleted,
    TaskFailed,
    TaskCancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskEvent {
    protocol_version: u16,
    sequence: u64,
    kind: AgentTaskEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_id: Option<String>,
    task: AgentTask,
}

pub(crate) struct AgentTaskManager {
    tasks: Mutex<HashMap<String, AgentTask>>,
    plan_controls: Mutex<HashMap<String, AgentPlanControl>>,
    approval_credentials: Mutex<ApprovalCredentialStore>,
}

struct AgentPlanControl {
    plan_id: String,
    approval_requirements: HashMap<String, String>,
    sender: watch::Sender<AgentPlanDecision>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentPlanApproval {
    selected_call_ids: Vec<String>,
    credentials: Vec<ApprovalCredential>,
}

impl AgentPlanApproval {
    pub(crate) fn selected_call_ids(&self) -> &[String] {
        &self.selected_call_ids
    }

    pub(crate) fn credential_for(&self, call_id: &str) -> Option<&ApprovalCredential> {
        self.credentials
            .iter()
            .find(|credential| credential.call_id() == call_id)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AgentPlanDecision {
    Pending,
    Approve(AgentPlanApproval),
    Reject,
    Stop,
}

impl Default for AgentTaskManager {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            plan_controls: Mutex::new(HashMap::new()),
            approval_credentials: Mutex::new(ApprovalCredentialStore::default()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentPlanDecisionKind {
    Approve,
    Reject,
    Stop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPlanDecisionRequest {
    task_id: String,
    plan_id: String,
    decision: AgentPlanDecisionKind,
    #[serde(default)]
    selected_call_ids: Vec<String>,
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
    task_id: String,
    action_id: String,
    host_id: String,
    session_id: String,
    submission_id: String,
    phase: AgentCommandObservationPhase,
    command: String,
    exit_code: Option<u16>,
    duration_ms: Option<u64>,
    reason: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorizedAgentAction {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) tool: String,
    pub(crate) arguments: serde_json::Value,
    pub(crate) session_id: String,
    pub(crate) rollback: bool,
    pub(crate) prepares_command: bool,
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

fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_AGENT_ID_CHARS
}

fn remote_parent_path(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &path[..index],
    }
}

fn bounded_action_message(value: Option<String>) -> Result<Option<String>, String> {
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

impl AgentTaskContext {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn terminal_session_id(&self) -> Option<&str> {
        self.terminal_session_id.as_deref()
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }

    pub(crate) fn approval_mode(&self) -> AgentApprovalMode {
        self.approval_mode
    }

    pub(crate) fn current_directory(&self) -> Option<&str> {
        self.current_directory.as_deref()
    }

    fn validate(&self) -> Result<(), String> {
        if !valid_identifier(&self.id)
            || !valid_identifier(&self.conversation_id)
            || !valid_identifier(&self.host_id)
            || self
                .terminal_session_id
                .as_deref()
                .is_some_and(|value| !valid_identifier(value))
            || self.current_directory.as_deref().is_some_and(|value| {
                value.trim().is_empty()
                    || !value.starts_with('/')
                    || value.chars().count() > 1_024
                    || value.chars().any(char::is_control)
            })
            || self
                .file_operation_directory
                .as_deref()
                .is_some_and(|value| {
                    normalize_remote_action_path(value).as_deref() != Ok(value)
                        || self.current_directory.as_deref() != Some(value)
                })
        {
            return Err("AI 任务作用域无效".to_string());
        }
        if self.writable_files.len() > MAX_AGENT_WRITABLE_FILES {
            return Err("AI 任务可写文件数量超过限制".to_string());
        }
        let mut paths = std::collections::HashSet::new();
        let mut total_bytes = 0_usize;
        for file in &self.writable_files {
            let content_bytes = file.content.len();
            if normalize_remote_action_path(&file.path).as_deref() != Ok(file.path.as_str())
                || !paths.insert(file.path.as_str())
                || content_bytes > MAX_AGENT_WRITABLE_FILE_BYTES
                || file.content.contains('\0')
                || u64::try_from(content_bytes).ok() != Some(file.size)
            {
                return Err("AI 任务可写文件快照无效".to_string());
            }
            total_bytes = total_bytes.saturating_add(content_bytes);
        }
        if total_bytes > MAX_AGENT_WRITABLE_FILES_BYTES {
            return Err("AI 任务可写文件总大小超过限制".to_string());
        }
        let objective = self.objective.trim();
        if objective.is_empty() || objective.chars().count() > MAX_AGENT_OBJECTIVE_CHARS {
            return Err("AI 任务目标无效".to_string());
        }
        Ok(())
    }

    fn matches(&self, task: &AgentTask) -> bool {
        self.id == task.id
            && self.conversation_id == task.conversation_id
            && self.host_id == task.host_id
            && self.terminal_session_id == task.terminal_session_id
            && self.current_directory == task.current_directory
            && self.file_operation_directory == task.file_operation_directory
            && self.writable_files == task.writable_files
            && self.approval_mode == task.approval_mode
            && self.objective.trim() == task.objective
    }
}

impl AgentTask {
    fn from_context(context: &AgentTaskContext) -> Self {
        let now = timestamp_ms();
        Self {
            id: context.id.clone(),
            conversation_id: context.conversation_id.clone(),
            host_id: context.host_id.clone(),
            terminal_session_id: context.terminal_session_id.clone(),
            current_directory: context.current_directory.clone(),
            file_operation_directory: context.file_operation_directory.clone(),
            writable_files: context.writable_files.clone(),
            approval_mode: context.approval_mode,
            status: AgentTaskStatus::Understanding,
            objective: context.objective.trim().to_string(),
            plan: None,
            active_step_id: None,
            actions: Vec::new(),
            model_completed: false,
            iteration: 0,
            repair_attempts: 0,
            repair_limit: MAX_AGENT_REPAIR_ATTEMPTS,
            repair_stop_reason: None,
            last_event_sequence: 0,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn event(&mut self, kind: AgentTaskEventKind) -> AgentTaskEvent {
        self.event_for_action(kind, None)
    }

    fn action_event(&mut self, kind: AgentTaskEventKind, action_id: &str) -> AgentTaskEvent {
        self.event_for_action(kind, Some(action_id.to_string()))
    }

    fn event_for_action(
        &mut self,
        kind: AgentTaskEventKind,
        action_id: Option<String>,
    ) -> AgentTaskEvent {
        self.last_event_sequence = self.last_event_sequence.saturating_add(1);
        self.updated_at = timestamp_ms();
        AgentTaskEvent {
            protocol_version: PROTOCOL_VERSION,
            sequence: self.last_event_sequence,
            kind,
            action_id,
            task: self.clone(),
        }
    }

    fn has_unresolved_actions(&self) -> bool {
        self.actions.iter().any(|action| {
            action.status.is_unresolved()
                || (matches!(
                    action.status,
                    AgentActionStatus::Succeeded | AgentActionStatus::RolledBack
                ) && action.verification_status == AgentVerificationStatus::Pending)
        })
    }

    fn refresh_action_status(&mut self) {
        self.status = if self
            .actions
            .iter()
            .any(|action| action.status == AgentActionStatus::Pending)
        {
            AgentTaskStatus::AwaitingApproval
        } else {
            AgentTaskStatus::Running
        };
    }

    fn complete_actions(&mut self) {
        let has_failure = self.actions.iter().any(|action| {
            matches!(
                action.status,
                AgentActionStatus::Conflict
                    | AgentActionStatus::Failed
                    | AgentActionStatus::RollbackConflict
                    | AgentActionStatus::RollbackFailed
                    | AgentActionStatus::Cancelled
            )
        });
        let has_verification_failure = self
            .actions
            .iter()
            .any(|action| action.verification_status == AgentVerificationStatus::Failed);
        let (applicable_actions, verified_actions) =
            self.actions
                .iter()
                .fold((0_usize, 0_usize), |(applicable, verified), action| {
                    if action.verification_status == AgentVerificationStatus::NotApplicable {
                        (applicable, verified)
                    } else {
                        (
                            applicable + 1,
                            verified
                                + usize::from(
                                    action.verification_status == AgentVerificationStatus::Verified,
                                ),
                        )
                    }
                });
        let verification_status = if applicable_actions == 0 {
            AgentVerificationStatus::NotApplicable
        } else if (has_failure || has_verification_failure) && verified_actions == 0 {
            AgentVerificationStatus::Failed
        } else if verified_actions == applicable_actions {
            AgentVerificationStatus::Verified
        } else if verified_actions > 0 {
            AgentVerificationStatus::Partial
        } else {
            AgentVerificationStatus::Unverified
        };
        self.repair_stop_reason = if has_verification_failure {
            Some(if self.repair_attempts >= self.repair_limit {
                AgentRepairStopReason::RepairBudgetExhausted
            } else {
                AgentRepairStopReason::VerificationFailed
            })
        } else if has_failure {
            Some(if self.repair_attempts >= self.repair_limit {
                AgentRepairStopReason::RepairBudgetExhausted
            } else {
                AgentRepairStopReason::ActionFailed
            })
        } else {
            None
        };
        self.status = AgentTaskStatus::Completed;
        self.result = Some(AgentTaskResult {
            summary: if has_failure {
                "AI 任务已结束，部分动作未成功完成".to_string()
            } else if has_verification_failure {
                "AI 任务已完成执行，但业务验证未通过".to_string()
            } else if verification_status == AgentVerificationStatus::Unverified {
                "AI 任务已完成，但尚无充分验证证据".to_string()
            } else if verification_status == AgentVerificationStatus::Partial {
                "AI 任务已完成，部分结果已经验证".to_string()
            } else {
                "AI 任务已完成".to_string()
            },
            verified: verification_status == AgentVerificationStatus::Verified,
            verification_status,
            stop_reason: self
                .repair_stop_reason
                .map(|reason| match reason {
                    AgentRepairStopReason::VerificationFailed => "verification_failed",
                    AgentRepairStopReason::ActionFailed => "action_failed",
                    AgentRepairStopReason::RepairBudgetExhausted => "repair_budget_exhausted",
                })
                .map(str::to_string),
        });
    }

    fn trusted_execution_arguments(
        &self,
        intent: &AgentActionIntent,
    ) -> Result<serde_json::Value, String> {
        let arguments = intent
            .arguments
            .as_object()
            .ok_or_else(|| "AI 动作参数无效".to_string())?;
        match intent.tool.as_str() {
            "propose_file_edit" => {
                let path = arguments
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件修改路径无效".to_string())?;
                let content = arguments
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件修改内容无效".to_string())?;
                let original = self
                    .writable_files
                    .iter()
                    .find(|file| file.path == path)
                    .ok_or_else(|| "AI 文件修改不在本次可写边界中".to_string())?;
                if original.content == content {
                    return Err("AI 文件修改没有产生变化".to_string());
                }
                Ok(serde_json::json!({
                    "content": content,
                    "originalContent": original.content,
                    "path": path,
                }))
            }
            "propose_file_operation" => {
                let operation = arguments
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件操作类型无效".to_string())?;
                let path = arguments
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "AI 文件操作路径无效".to_string())?;
                match operation {
                    "create" => {
                        if self.file_operation_directory.as_deref()
                            != Some(remote_parent_path(path))
                        {
                            return Err("AI 新建文件不在本次可写目录中".to_string());
                        }
                        Ok(intent.arguments.clone())
                    }
                    "rename" | "delete" => {
                        let original = self
                            .writable_files
                            .iter()
                            .find(|file| file.path == path)
                            .ok_or_else(|| "AI 文件操作不在本次可写边界中".to_string())?;
                        if operation == "rename" {
                            let target_path = arguments
                                .get("targetPath")
                                .and_then(serde_json::Value::as_str)
                                .ok_or_else(|| "AI 重命名目标路径无效".to_string())?;
                            if remote_parent_path(target_path) != remote_parent_path(path) {
                                return Err("AI 重命名目标必须与源文件位于同一目录".to_string());
                            }
                        }
                        let mut trusted = arguments.clone();
                        trusted.insert(
                            "expectedContent".to_string(),
                            serde_json::Value::String(original.content.clone()),
                        );
                        Ok(serde_json::Value::Object(trusted))
                    }
                    _ => Err("AI 文件操作类型无效".to_string()),
                }
            }
            "propose_terminal_command" => {
                if self.terminal_session_id.is_none() {
                    return Err("AI 终端命令缺少绑定会话".to_string());
                }
                Ok(intent.arguments.clone())
            }
            _ => Err("AI 动作不在可信执行注册表中".to_string()),
        }
    }
}

impl AgentTaskManager {
    pub(crate) fn begin_model_turn(
        &self,
        context: &AgentTaskContext,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        context.validate()?;
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let mut events = Vec::with_capacity(2);

        if !tasks.contains_key(&context.id) {
            if tasks.len() >= MAX_AGENT_TASKS {
                let oldest_terminal = tasks
                    .iter()
                    .filter(|(_, task)| task.status.is_terminal())
                    .min_by_key(|(_, task)| task.updated_at)
                    .map(|(id, _)| id.clone());
                let Some(task_id) = oldest_terminal else {
                    return Err("正在运行的 AI 任务过多".to_string());
                };
                tasks.remove(&task_id);
            }
            let mut task = AgentTask::from_context(context);
            events.push(task.event(AgentTaskEventKind::TaskCreated));
            tasks.insert(context.id.clone(), task);
        }

        let task = tasks
            .get_mut(&context.id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if !context.matches(task) {
            return Err("AI 任务作用域与已有任务不一致".to_string());
        }
        if task.status.is_terminal() {
            return Err("AI 任务已经结束".to_string());
        }
        task.status = AgentTaskStatus::Running;
        task.model_completed = false;
        task.iteration = task.iteration.saturating_add(1);
        task.error = None;
        events.push(task.event(AgentTaskEventKind::ModelTurnStarted));
        Ok(events)
    }

    pub(crate) fn finish_model_turn(
        &self,
        task_id: &str,
        has_tool_calls: bool,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let Some(task) = tasks.get_mut(task_id) else {
                return Ok(Vec::new());
            };
            if task.status.is_terminal() {
                return Ok(Vec::new());
            }
            if has_tool_calls || task.has_unresolved_actions() {
                task.model_completed = !has_tool_calls;
                if task.has_unresolved_actions() {
                    task.refresh_action_status();
                } else {
                    task.status = AgentTaskStatus::Running;
                }
                vec![task.event(AgentTaskEventKind::ModelTurnCompleted)]
            } else {
                task.model_completed = true;
                task.complete_actions();
                if task.actions.is_empty() {
                    task.result.as_mut().unwrap().verified = false;
                }
                vec![task.event(AgentTaskEventKind::TaskCompleted)]
            }
        };
        if !has_tool_calls {
            self.revoke_task_approvals(task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn register_actions(
        &self,
        task_id: &str,
        intents: Vec<AgentActionIntent>,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if intents.is_empty() {
            return Ok(Vec::new());
        }
        if intents.len() > MAX_AGENT_ACTIONS {
            return Err("AI 动作数量超过限制".to_string());
        }
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("AI 任务已经结束".to_string());
        }
        if task.actions.len().saturating_add(intents.len()) > MAX_AGENT_ACTIONS {
            return Err("AI 任务动作数量超过限制".to_string());
        }
        let mut incoming_ids = std::collections::HashSet::new();
        if intents.iter().any(|intent| {
            !valid_identifier(&intent.id)
                || !incoming_ids.insert(intent.id.clone())
                || task.actions.iter().any(|action| action.id == intent.id)
                || action_fingerprint(&intent.tool, &intent.arguments).is_err()
        }) {
            return Err("AI 动作标识或参数无效".to_string());
        }
        let mut events = Vec::with_capacity(intents.len());
        for intent in intents {
            let action_id = intent.id.clone();
            let arguments = task.trusted_execution_arguments(&intent)?;
            let mut action = AgentActionState::from_intent(intent);
            action.arguments = arguments;
            task.actions.push(action);
            task.refresh_action_status();
            events.push(task.action_event(AgentTaskEventKind::ActionProposed, &action_id));
        }
        Ok(events)
    }

    pub(crate) fn transition_action(
        &self,
        request: AgentActionTransitionRequest,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if !valid_identifier(&request.task_id) || !valid_identifier(&request.action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let summary = bounded_action_message(request.summary)?;
        let error = bounded_action_message(request.error)?;
        let task_id = request.task_id;
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let index = task
                .actions
                .iter()
                .position(|action| action.id == request.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let action_id = task.actions[index].id.clone();
            if task.status == AgentTaskStatus::Completed
                && !matches!(
                    request.transition,
                    AgentActionTransition::Retry | AgentActionTransition::RollbackStart
                )
            {
                return Err("AI 动作已经结束".to_string());
            }
            action_fingerprint(&task.actions[index].tool, &task.actions[index].arguments)?;
            let now = timestamp_ms();
            let mut events = Vec::with_capacity(3);
            match request.transition {
                AgentActionTransition::Approve => {
                    if task.actions[index].status != AgentActionStatus::Pending {
                        return Err("AI 动作当前不能批准".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Approved;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionApproved, &action_id));
                }
                AgentActionTransition::Reject => {
                    if !matches!(
                        task.actions[index].status,
                        AgentActionStatus::Pending | AgentActionStatus::Approved
                    ) {
                        return Err("AI 动作当前不能拒绝".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Rejected;
                    task.actions[index].summary =
                        summary.or_else(|| Some("用户拒绝了该动作".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].verification_status =
                        AgentVerificationStatus::NotApplicable;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionRejected, &action_id));
                }
                AgentActionTransition::Start => {
                    if task.actions[index].status == AgentActionStatus::Pending {
                        task.actions[index].status = AgentActionStatus::Approved;
                        task.actions[index].summary = Some("用户批准了该动作".to_string());
                        task.refresh_action_status();
                        events.push(
                            task.action_event(AgentTaskEventKind::ActionApproved, &action_id),
                        );
                    }
                    if task.actions[index].status != AgentActionStatus::Approved {
                        return Err("AI 动作当前不能开始".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Running;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionStarted, &action_id));
                }
                AgentActionTransition::Succeed => {
                    if task.actions[index].status != AgentActionStatus::Running {
                        return Err("AI 动作当前不能标记为成功".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::Succeeded;
                    task.actions[index].summary =
                        summary.or_else(|| Some("动作已成功完成".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Unverified;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionSucceeded, &action_id));
                }
                AgentActionTransition::Conflict => {
                    let (status, kind) = match task.actions[index].status {
                        AgentActionStatus::Running => (
                            AgentActionStatus::Conflict,
                            AgentTaskEventKind::ActionConflicted,
                        ),
                        AgentActionStatus::RollingBack => (
                            AgentActionStatus::RollbackConflict,
                            AgentTaskEventKind::ActionRollbackConflicted,
                        ),
                        _ => return Err("AI 动作当前不能标记为冲突".to_string()),
                    };
                    task.actions[index].status = status;
                    task.actions[index].error =
                        error.or_else(|| Some("远端状态发生冲突".to_string()));
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Failed;
                    if status == AgentActionStatus::RollbackConflict {
                        task.actions[index].update_recovery(
                            AgentRecoveryRecommendation::Rollback,
                            AgentRecoveryStatus::Failed,
                            "回滚时远端状态发生冲突，需要人工检查",
                            now,
                        );
                    } else {
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                    }
                    task.refresh_action_status();
                    events.push(task.action_event(kind, &action_id));
                }
                AgentActionTransition::Fail => {
                    let (status, kind) = match task.actions[index].status {
                        AgentActionStatus::Approved | AgentActionStatus::Running => {
                            (AgentActionStatus::Failed, AgentTaskEventKind::ActionFailed)
                        }
                        AgentActionStatus::RollingBack => (
                            AgentActionStatus::RollbackFailed,
                            AgentTaskEventKind::ActionRollbackFailed,
                        ),
                        _ => return Err("AI 动作当前不能标记为失败".to_string()),
                    };
                    task.actions[index].status = status;
                    task.actions[index].error = error.or_else(|| Some("动作执行失败".to_string()));
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Failed;
                    if status == AgentActionStatus::RollbackFailed {
                        task.actions[index].update_recovery(
                            AgentRecoveryRecommendation::Rollback,
                            AgentRecoveryStatus::Failed,
                            "回滚执行失败，需要人工检查远端状态",
                            now,
                        );
                    } else {
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                    }
                    task.refresh_action_status();
                    events.push(task.action_event(kind, &action_id));
                }
                AgentActionTransition::RollbackStart => {
                    if task.actions[index].status != AgentActionStatus::Succeeded {
                        return Err("AI 动作当前不能回滚".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::RollingBack;
                    task.actions[index].summary = summary;
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Rollback,
                        AgentRecoveryStatus::Running,
                        "正在回滚并等待恢复状态验证",
                        now,
                    );
                    task.result = None;
                    task.refresh_action_status();
                    events.push(
                        task.action_event(AgentTaskEventKind::ActionRollbackStarted, &action_id),
                    );
                }
                AgentActionTransition::RolledBack => {
                    if task.actions[index].status != AgentActionStatus::RollingBack {
                        return Err("AI 动作当前不能标记为已回滚".to_string());
                    }
                    task.actions[index].status = AgentActionStatus::RolledBack;
                    task.actions[index].summary =
                        summary.or_else(|| Some("动作已安全回滚".to_string()));
                    task.actions[index].error = None;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = task.actions[index]
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    task.actions[index].verification_status = AgentVerificationStatus::Unverified;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Rollback,
                        AgentRecoveryStatus::Unverified,
                        "回滚动作已结束，但未取得可信的恢复状态证据",
                        now,
                    );
                    task.refresh_action_status();
                    events
                        .push(task.action_event(AgentTaskEventKind::ActionRolledBack, &action_id));
                }
                AgentActionTransition::Retry => {
                    let verification_failed = matches!(
                        task.actions[index].status,
                        AgentActionStatus::Succeeded | AgentActionStatus::RolledBack
                    ) && task.actions[index].verification_status
                        == AgentVerificationStatus::Failed;
                    if !verification_failed
                        && !matches!(
                            task.actions[index].status,
                            AgentActionStatus::Conflict
                                | AgentActionStatus::Failed
                                | AgentActionStatus::RollbackConflict
                                | AgentActionStatus::RollbackFailed
                        )
                    {
                        return Err("AI 动作当前不能重试".to_string());
                    }
                    if task.repair_attempts >= task.repair_limit {
                        task.repair_stop_reason =
                            Some(AgentRepairStopReason::RepairBudgetExhausted);
                        if let Some(result) = task.result.as_mut() {
                            result.stop_reason = Some("repair_budget_exhausted".to_string());
                        }
                        return Err("AI 任务修复次数已达到上限".to_string());
                    }
                    task.repair_attempts = task.repair_attempts.saturating_add(1);
                    task.repair_stop_reason = None;
                    task.actions[index].update_recovery(
                        AgentRecoveryRecommendation::Retry,
                        AgentRecoveryStatus::Running,
                        format!(
                            "正在执行第 {} 次修复，完成后将重新验证目标状态",
                            task.repair_attempts
                        ),
                        now,
                    );
                    task.actions[index].status = AgentActionStatus::Pending;
                    task.actions[index].summary = None;
                    task.actions[index].error = None;
                    task.actions[index].started_at = None;
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.actions[index].verification_status = AgentVerificationStatus::Pending;
                    task.actions[index].verification_evidence.clear();
                    task.actions[index].command_submission_id = None;
                    task.result = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionRetried, &action_id));
                }
            }
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn observe_command_execution(
        &self,
        request: AgentCommandObservationRequest,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if [
            request.task_id.as_str(),
            request.action_id.as_str(),
            request.host_id.as_str(),
            request.session_id.as_str(),
            request.submission_id.as_str(),
        ]
        .into_iter()
        .any(|value| !valid_identifier(value))
            || !valid_command(&request.command)
        {
            return Err("终端命令观察范围无效".to_string());
        }
        if request
            .duration_ms
            .is_some_and(|duration| duration > MAX_OBSERVED_COMMAND_DURATION_MS)
            || request.exit_code.is_some_and(|exit_code| exit_code > 255)
        {
            return Err("终端命令观察结果无效".to_string());
        }
        let reason = bounded_action_message(request.reason)?;
        match request.phase {
            AgentCommandObservationPhase::Submitted
                if request.exit_code.is_some()
                    || request.duration_ms.is_some()
                    || reason.is_some() =>
            {
                return Err("终端命令提交事件包含无效结果".to_string());
            }
            AgentCommandObservationPhase::Completed
                if request.exit_code.is_none()
                    || request.duration_ms.is_none()
                    || reason.is_some() =>
            {
                return Err("终端命令完成事件缺少退出信息".to_string());
            }
            AgentCommandObservationPhase::Unavailable
                if request.exit_code.is_some()
                    || request.duration_ms.is_none()
                    || reason.is_none() =>
            {
                return Err("终端命令不可用事件缺少原因".to_string());
            }
            _ => {}
        }

        let task_id = request.task_id;
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let index = task
                .actions
                .iter()
                .position(|action| action.id == request.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            if task.actions[index].tool != "propose_terminal_command" {
                return Err("AI 动作不是终端命令提案".to_string());
            }
            let trusted_command = task.actions[index]
                .arguments
                .get("command")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "AI 命令缺少可信参数".to_string())?;
            let business_verification = task.actions[index]
                .arguments
                .get("verification")
                .cloned()
                .map(AgentBusinessVerification::from_value)
                .transpose()?;
            if task.host_id != request.host_id
                || task.terminal_session_id.as_deref() != Some(request.session_id.as_str())
                || trusted_command != request.command.trim()
            {
                return Err("终端提交与 AI 命令提案不匹配".to_string());
            }
            let same_submission = task.actions[index].command_submission_id.as_deref()
                == Some(request.submission_id.as_str());
            if matches!(
                task.actions[index].status,
                AgentActionStatus::Succeeded | AgentActionStatus::Failed
            ) {
                if same_submission {
                    return Ok(Vec::new());
                }
                return Err("AI 命令已经由其他终端提交结束".to_string());
            }
            if matches!(
                task.status,
                AgentTaskStatus::Completed | AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }

            let action_id = task.actions[index].id.clone();
            let now = timestamp_ms();
            let mut events = Vec::with_capacity(3);
            match task.actions[index].status {
                AgentActionStatus::Approved => {
                    task.actions[index].command_submission_id = Some(request.submission_id.clone());
                    task.actions[index].status = AgentActionStatus::Running;
                    task.actions[index].summary = Some("用户已在终端提交命令".to_string());
                    task.actions[index].error = None;
                    task.actions[index].started_at = Some(now);
                    task.actions[index].completed_at = None;
                    task.actions[index].duration_ms = None;
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionStarted, &action_id));
                }
                AgentActionStatus::Running if same_submission => {
                    if request.phase == AgentCommandObservationPhase::Submitted {
                        return Ok(Vec::new());
                    }
                }
                AgentActionStatus::Running => {
                    return Err("AI 命令已经绑定其他终端提交".to_string());
                }
                _ => return Err("AI 命令当前不能接收执行结果".to_string()),
            }

            match request.phase {
                AgentCommandObservationPhase::Submitted => {}
                AgentCommandObservationPhase::Completed => {
                    let exit_code = request.exit_code.unwrap_or_default();
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = request.duration_ms;
                    if exit_code == 0 {
                        task.actions[index].status = AgentActionStatus::Succeeded;
                        task.actions[index].summary = Some("终端命令执行成功".to_string());
                        task.actions[index].error = None;
                        task.actions[index].record_verification(
                            if business_verification.is_some() {
                                AgentVerificationStatus::Pending
                            } else {
                                AgentVerificationStatus::Unverified
                            },
                            AgentVerificationEvidenceKind::CommandExitStatus,
                            if business_verification.is_some() {
                                "命令退出码为 0，等待业务目标验证"
                            } else {
                                "命令退出码为 0，仅确认命令进程正常结束"
                            },
                            now,
                        );
                        if business_verification.is_some() {
                            task.status = AgentTaskStatus::Verifying;
                        } else {
                            task.actions[index].finish_repair_verification(false, now);
                            task.refresh_action_status();
                        }
                        events.push(
                            task.action_event(AgentTaskEventKind::ActionSucceeded, &action_id),
                        );
                    } else {
                        task.actions[index].status = AgentActionStatus::Failed;
                        task.actions[index].summary = None;
                        task.actions[index].error = Some(format!("终端命令退出码 {exit_code}"));
                        task.actions[index].record_verification(
                            AgentVerificationStatus::Failed,
                            AgentVerificationEvidenceKind::CommandExitStatus,
                            format!("命令以退出码 {exit_code} 结束"),
                            now,
                        );
                        let retry_available = task.repair_attempts < task.repair_limit;
                        task.actions[index].suggest_repair(retry_available, now);
                        task.refresh_action_status();
                        events
                            .push(task.action_event(AgentTaskEventKind::ActionFailed, &action_id));
                    }
                    events.push(
                        task.action_event(
                            AgentTaskEventKind::ActionVerificationRecorded,
                            &action_id,
                        ),
                    );
                }
                AgentCommandObservationPhase::Unavailable => {
                    task.actions[index].status = AgentActionStatus::Failed;
                    task.actions[index].summary = None;
                    task.actions[index].error = reason;
                    task.actions[index].completed_at = Some(now);
                    task.actions[index].duration_ms = request.duration_ms;
                    task.actions[index].record_verification(
                        AgentVerificationStatus::Failed,
                        AgentVerificationEvidenceKind::ResultUnavailable,
                        "无法确认终端命令的结束状态",
                        now,
                    );
                    let retry_available = task.repair_attempts < task.repair_limit;
                    task.actions[index].suggest_repair(retry_available, now);
                    task.refresh_action_status();
                    events.push(task.action_event(AgentTaskEventKind::ActionFailed, &action_id));
                    events.push(
                        task.action_event(
                            AgentTaskEventKind::ActionVerificationRecorded,
                            &action_id,
                        ),
                    );
                }
            }
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn pending_business_verification(
        &self,
        task_id: &str,
        action_id: &str,
    ) -> Result<Option<PendingBusinessVerification>, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let Some(task) = tasks.get(task_id) else {
            return Err("AI 任务不存在".to_string());
        };
        let Some(action) = task.actions.iter().find(|action| action.id == action_id) else {
            return Err("AI 动作不存在".to_string());
        };
        if action.status != AgentActionStatus::Succeeded
            || action.verification_status != AgentVerificationStatus::Pending
        {
            return Ok(None);
        }
        let verification = action
            .arguments
            .get("verification")
            .cloned()
            .map(AgentBusinessVerification::from_value)
            .transpose()?;
        Ok(
            verification.map(|verification| PendingBusinessVerification {
                task_id: task_id.to_string(),
                action_id: action_id.to_string(),
                session_id: task.terminal_session_id.clone().unwrap_or_default(),
                verification,
            }),
        )
    }

    pub(crate) fn complete_business_verification(
        &self,
        pending: &PendingBusinessVerification,
        result: Result<AgentBusinessVerificationResult, String>,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let task_id = pending.task_id.clone();
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let task = tasks
                .get_mut(&task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let index = task
                .actions
                .iter()
                .position(|action| action.id == pending.action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            if task.actions[index].status != AgentActionStatus::Succeeded
                || task.actions[index].verification_status != AgentVerificationStatus::Pending
            {
                return Ok(Vec::new());
            }
            let now = timestamp_ms();
            let (status, kind, summary) = match result {
                Ok(result) => (
                    if result.passed {
                        AgentVerificationStatus::Verified
                    } else {
                        AgentVerificationStatus::Failed
                    },
                    match pending.verification.kind() {
                        AgentBusinessVerificationKind::ServiceStatus => {
                            AgentVerificationEvidenceKind::ServiceStatus
                        }
                        AgentBusinessVerificationKind::PortListening => {
                            AgentVerificationEvidenceKind::PortListening
                        }
                        AgentBusinessVerificationKind::ConfigSyntax => {
                            AgentVerificationEvidenceKind::ConfigSyntax
                        }
                    },
                    result.summary,
                ),
                Err(_) => (
                    AgentVerificationStatus::Failed,
                    AgentVerificationEvidenceKind::ResultUnavailable,
                    "无法取得业务验证结果".to_string(),
                ),
            };
            task.actions[index].record_verification(status, kind, summary, now);
            if status == AgentVerificationStatus::Verified {
                task.actions[index].finish_repair_verification(true, now);
            } else {
                let retry_available = task.repair_attempts < task.repair_limit;
                task.actions[index].suggest_repair(retry_available, now);
            }
            task.refresh_action_status();
            let action_id = pending.action_id.clone();
            let mut events =
                vec![task.action_event(AgentTaskEventKind::ActionVerificationRecorded, &action_id)];
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(&task_id)?;
        }
        Ok(events)
    }

    pub(crate) fn complete_trusted_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        verification: AgentTrustedVerification,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let task = tasks
                .get_mut(task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let index = task
                .actions
                .iter()
                .position(|action| action.id == action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let expected_status = if rollback {
                AgentActionStatus::RollingBack
            } else {
                AgentActionStatus::Running
            };
            if task.actions[index].status != expected_status {
                return Err("AI 动作当前不能记录可信执行结果".to_string());
            }
            if !matches!(
                (task.actions[index].tool.as_str(), verification),
                (
                    "propose_file_edit",
                    AgentTrustedVerification::RemoteContentMatch
                ) | ("propose_file_operation", _)
            ) {
                return Err("AI 动作与可信验证结果不匹配".to_string());
            }
            action_fingerprint(&task.actions[index].tool, &task.actions[index].arguments)?;

            let now = timestamp_ms();
            let (status, event_kind, summary, evidence_kind, evidence_summary) = if rollback {
                (
                    AgentActionStatus::RolledBack,
                    AgentTaskEventKind::ActionRolledBack,
                    "动作已安全回滚",
                    AgentVerificationEvidenceKind::RecoveryStateMatch,
                    "远端恢复状态与回滚目标一致",
                )
            } else {
                let (evidence_kind, evidence_summary) = match verification {
                    AgentTrustedVerification::RemoteContentMatch => (
                        AgentVerificationEvidenceKind::RemoteContentMatch,
                        "远端文件内容与本次写入结果一致",
                    ),
                    AgentTrustedVerification::RemotePathState => (
                        AgentVerificationEvidenceKind::RemotePathState,
                        "远端路径状态与本次文件操作结果一致",
                    ),
                };
                (
                    AgentActionStatus::Succeeded,
                    AgentTaskEventKind::ActionSucceeded,
                    "动作已成功完成",
                    evidence_kind,
                    evidence_summary,
                )
            };
            task.actions[index].status = status;
            task.actions[index].summary = Some(summary.to_string());
            task.actions[index].error = None;
            task.actions[index].completed_at = Some(now);
            task.actions[index].duration_ms = task.actions[index]
                .started_at
                .map(|started_at| now.saturating_sub(started_at));
            task.actions[index].record_verification(
                AgentVerificationStatus::Verified,
                evidence_kind,
                evidence_summary,
                now,
            );
            if rollback {
                task.actions[index].update_recovery(
                    AgentRecoveryRecommendation::Rollback,
                    AgentRecoveryStatus::Verified,
                    "远端恢复状态与回滚目标一致",
                    now,
                );
            } else {
                task.actions[index].finish_repair_verification(true, now);
            }
            task.refresh_action_status();
            let mut events = vec![
                task.action_event(event_kind, action_id),
                task.action_event(AgentTaskEventKind::ActionVerificationRecorded, action_id),
            ];
            if task.model_completed && !task.has_unresolved_actions() {
                task.complete_actions();
                events.push(task.event(AgentTaskEventKind::TaskCompleted));
            }
            events
        };
        if events
            .last()
            .is_some_and(|event| event.kind == AgentTaskEventKind::TaskCompleted)
        {
            self.revoke_task_approvals(task_id)?;
        }
        Ok(events)
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
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
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
            let prepares_command = action.tool == "propose_terminal_command";
            if rollback && prepares_command {
                return Err("终端命令不能通过文件回滚流程撤销".to_string());
            }
            if rollback {
                if action.status != AgentActionStatus::Succeeded {
                    return Err("AI 动作当前不能回滚".to_string());
                }
            } else if prepares_command {
                if action.status != AgentActionStatus::Pending {
                    return Err("AI 命令当前不能再次填入".to_string());
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
                    rollback,
                    prepares_command,
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
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
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
        } else if execution.prepares_command {
            AgentActionTransition::Approve
        } else {
            AgentActionTransition::Start
        };
        let summary = if rollback {
            "用户确认回滚该动作"
        } else if execution.prepares_command {
            "用户批准将命令填入终端"
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

    pub(crate) fn set_plan(
        &self,
        task_id: &str,
        mut plan: AgentPlan,
        approval_requirements: HashMap<String, String>,
    ) -> Result<(watch::Receiver<AgentPlanDecision>, Vec<AgentTaskEvent>), String> {
        if approval_requirements.len() > plan.steps.len()
            || approval_requirements
                .keys()
                .any(|call_id| !plan.steps.iter().any(|step| step.id == *call_id))
            || approval_requirements
                .values()
                .any(|fingerprint| fingerprint.is_empty())
        {
            return Err("AI 计划审批范围无效".to_string());
        }
        let awaiting_approval = !approval_requirements.is_empty();
        let initial_decision = if awaiting_approval {
            AgentPlanDecision::Pending
        } else {
            AgentPlanDecision::Approve(AgentPlanApproval {
                selected_call_ids: plan.steps.iter().map(|step| step.id.clone()).collect(),
                credentials: Vec::new(),
            })
        };
        plan.status = AgentPlanStatus::Pending;
        let (sender, receiver) = watch::channel(initial_decision);
        self.revoke_task_approvals(task_id)?;
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("AI 任务已经结束".to_string());
        }
        task.status = if awaiting_approval {
            AgentTaskStatus::AwaitingApproval
        } else {
            AgentTaskStatus::Running
        };
        task.plan = Some(plan.clone());
        self.plan_controls
            .lock()
            .map_err(|_| "AI 计划控制状态不可用".to_string())?
            .insert(
                task_id.to_string(),
                AgentPlanControl {
                    plan_id: plan.id.clone(),
                    approval_requirements,
                    sender,
                },
            );
        Ok((receiver, vec![task.event(AgentTaskEventKind::PlanCreated)]))
    }

    pub(crate) fn update_plan(
        &self,
        task_id: &str,
        plan: AgentPlan,
        completed: bool,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(Vec::new());
        };
        if task.status.is_terminal() {
            return Ok(Vec::new());
        }
        task.status = AgentTaskStatus::Running;
        task.active_step_id = if completed {
            None
        } else {
            plan.steps
                .iter()
                .find(|step| step.status == AgentPlanStepStatus::InProgress)
                .map(|step| step.id.clone())
        };
        task.plan = Some(plan);
        Ok(vec![task.event(if completed {
            AgentTaskEventKind::PlanCompleted
        } else {
            AgentTaskEventKind::PlanUpdated
        })])
    }

    pub(crate) fn start_plan(
        &self,
        task_id: &str,
        mut plan: AgentPlan,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(Vec::new());
        };
        if task.status.is_terminal() {
            return Ok(Vec::new());
        }
        plan.status = AgentPlanStatus::Running;
        task.status = AgentTaskStatus::Running;
        task.active_step_id = None;
        task.plan = Some(plan);
        Ok(vec![task.event(AgentTaskEventKind::PlanStarted)])
    }

    pub(crate) fn clear_plan_control(&self, task_id: &str) {
        let plan_id = self
            .plan_controls
            .lock()
            .ok()
            .and_then(|mut controls| controls.remove(task_id).map(|control| control.plan_id));
        if let Some(plan_id) = plan_id {
            if let Ok(mut credentials) = self.approval_credentials.lock() {
                credentials.revoke_plan(task_id, &plan_id);
            }
        }
    }

    pub(crate) fn consume_approval(
        &self,
        credential: &ApprovalCredential,
        expected_scope: ApprovalScope,
    ) -> Result<(), String> {
        self.approval_credentials
            .lock()
            .map_err(|_| "AI 审批凭证状态不可用".to_string())?
            .consume(credential, &expected_scope, timestamp_ms())
    }

    fn revoke_task_approvals(&self, task_id: &str) -> Result<(), String> {
        self.approval_credentials
            .lock()
            .map_err(|_| "AI 审批凭证状态不可用".to_string())?
            .revoke_task(task_id);
        Ok(())
    }

    fn decide_plan(&self, request: AgentPlanDecisionRequest) -> Result<(), String> {
        if !valid_identifier(&request.task_id) || !valid_identifier(&request.plan_id) {
            return Err("AI 计划标识无效".to_string());
        }
        let selected_call_ids = request
            .selected_call_ids
            .into_iter()
            .map(|value| value.trim().to_string())
            .collect::<Vec<_>>();
        if selected_call_ids.len() > 6
            || selected_call_ids
                .iter()
                .any(|value| !valid_identifier(value))
            || selected_call_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != selected_call_ids.len()
        {
            return Err("AI 计划选择无效".to_string());
        }
        let (host_id, session_id, current_directory) = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let task = tasks
                .get(&request.task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            let plan = task
                .plan
                .as_ref()
                .filter(|plan| plan.id == request.plan_id)
                .ok_or_else(|| "AI 计划不存在".to_string())?;
            if selected_call_ids
                .iter()
                .any(|call_id| !plan.steps.iter().any(|step| step.id == *call_id))
            {
                return Err("AI 计划选择不属于当前计划".to_string());
            }
            (
                task.host_id.clone(),
                task.terminal_session_id.clone(),
                task.current_directory.clone(),
            )
        };
        let controls = self
            .plan_controls
            .lock()
            .map_err(|_| "AI 计划控制状态不可用".to_string())?;
        let control = controls
            .get(&request.task_id)
            .filter(|control| control.plan_id == request.plan_id)
            .ok_or_else(|| "AI 计划已经结束".to_string())?;
        let decision = match request.decision {
            AgentPlanDecisionKind::Approve => {
                if *control.sender.borrow() != AgentPlanDecision::Pending {
                    return Err("AI 计划已经作出决定".to_string());
                }
                let mut credentials = self
                    .approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?;
                credentials.revoke_plan(&request.task_id, &request.plan_id);
                let issued = selected_call_ids
                    .iter()
                    .filter_map(|call_id| {
                        control
                            .approval_requirements
                            .get(call_id)
                            .map(|fingerprint| (call_id, fingerprint))
                    })
                    .map(|(call_id, action_fingerprint)| {
                        credentials.issue(
                            ApprovalScope {
                                task_id: request.task_id.clone(),
                                plan_id: request.plan_id.clone(),
                                call_id: call_id.clone(),
                                host_id: host_id.clone(),
                                session_id: session_id.clone(),
                                current_directory: current_directory.clone(),
                                action_fingerprint: action_fingerprint.clone(),
                            },
                            timestamp_ms(),
                            APPROVAL_CREDENTIAL_TTL_MS,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>();
                let issued = match issued {
                    Ok(issued) => issued,
                    Err(error) => {
                        credentials.revoke_plan(&request.task_id, &request.plan_id);
                        return Err(error);
                    }
                };
                AgentPlanDecision::Approve(AgentPlanApproval {
                    selected_call_ids,
                    credentials: issued,
                })
            }
            AgentPlanDecisionKind::Reject => {
                if *control.sender.borrow() != AgentPlanDecision::Pending {
                    return Err("AI 计划已经作出决定".to_string());
                }
                self.approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                    .revoke_plan(&request.task_id, &request.plan_id);
                AgentPlanDecision::Reject
            }
            AgentPlanDecisionKind::Stop => {
                self.approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                    .revoke_plan(&request.task_id, &request.plan_id);
                AgentPlanDecision::Stop
            }
        };
        let result = control
            .sender
            .send(decision)
            .map_err(|_| "AI 计划已经结束".to_string());
        if result.is_err() {
            self.approval_credentials
                .lock()
                .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                .revoke_plan(&request.task_id, &request.plan_id);
        }
        result
    }

    pub(crate) fn fail_task(
        &self,
        task_id: &str,
        message: &str,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let Some(task) = tasks.get_mut(task_id) else {
                return Ok(Vec::new());
            };
            if task.status.is_terminal() {
                return Ok(Vec::new());
            }
            task.status = AgentTaskStatus::Failed;
            task.active_step_id = None;
            task.error = Some(message.chars().take(500).collect());
            vec![task.event(AgentTaskEventKind::TaskFailed)]
        };
        self.revoke_task_approvals(task_id)?;
        Ok(events)
    }

    pub(crate) fn pause_disconnected(
        &self,
        task_id: &str,
        message: &str,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let Some(task) = tasks.get_mut(task_id) else {
                return Ok(Vec::new());
            };
            if task.status.is_terminal() || task.status == AgentTaskStatus::PausedDisconnected {
                return Ok(Vec::new());
            }
            task.status = AgentTaskStatus::PausedDisconnected;
            task.error = Some(message.chars().take(500).collect());
            vec![task.event(AgentTaskEventKind::TaskPaused)]
        };
        self.revoke_task_approvals(task_id)?;
        Ok(events)
    }

    pub(crate) fn resume_disconnected(&self, task_id: &str) -> Result<Vec<AgentTaskEvent>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(Vec::new());
        };
        if task.status != AgentTaskStatus::PausedDisconnected {
            return Ok(Vec::new());
        }
        if task.has_unresolved_actions() {
            task.refresh_action_status();
        } else {
            task.status = AgentTaskStatus::Running;
        }
        task.error = None;
        Ok(vec![task.event(AgentTaskEventKind::TaskResumed)])
    }

    pub(crate) fn cancel_task(&self, task_id: &str) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| "AI 任务状态不可用".to_string())?;
            let Some(task) = tasks.get_mut(task_id) else {
                return Ok(Vec::new());
            };
            if task.status.is_terminal() {
                return Ok(Vec::new());
            }
            task.status = AgentTaskStatus::Cancelled;
            task.active_step_id = None;
            let now = timestamp_ms();
            for action in &mut task.actions {
                if action.status.is_unresolved() {
                    action.status = AgentActionStatus::Cancelled;
                    action.error = Some("用户取消了 AI 任务".to_string());
                    action.completed_at = Some(now);
                    action.duration_ms = action
                        .started_at
                        .map(|started_at| now.saturating_sub(started_at));
                    action.verification_status = AgentVerificationStatus::NotApplicable;
                }
            }
            if let Some(plan) = task.plan.as_mut() {
                plan.status = AgentPlanStatus::Cancelled;
                for step in &mut plan.steps {
                    if matches!(
                        step.status,
                        AgentPlanStepStatus::Pending | AgentPlanStepStatus::InProgress
                    ) {
                        step.status = AgentPlanStepStatus::Skipped;
                        step.summary = Some("用户取消了 AI 任务".to_string());
                        step.error = Some("用户取消了 AI 任务".to_string());
                    }
                }
            }
            task.result = Some(AgentTaskResult {
                summary: "AI 任务已取消".to_string(),
                verified: false,
                verification_status: AgentVerificationStatus::NotApplicable,
                stop_reason: Some("user_cancelled".to_string()),
            });
            vec![task.event(AgentTaskEventKind::TaskCancelled)]
        };
        if let Ok(controls) = self.plan_controls.lock() {
            if let Some(control) = controls.get(task_id) {
                let _ = control.sender.send(AgentPlanDecision::Stop);
            }
        }
        self.revoke_task_approvals(task_id)?;
        Ok(events)
    }

    fn get_task(&self, task_id: &str) -> Result<Option<AgentTask>, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())?;
        Ok(tasks.get(task_id).cloned())
    }
}

pub(crate) fn emit_task_events(app: &AppHandle, events: Vec<AgentTaskEvent>) {
    for event in events {
        let _ = app.emit_to("main", AGENT_TASK_EVENT, event);
    }
}

#[tauri::command]
pub(crate) fn ai_task_get(
    manager: State<'_, AgentTaskManager>,
    task_id: String,
) -> CommandResult<Option<AgentTask>> {
    let operation = "ai_task_get";
    if !valid_identifier(&task_id) {
        return Err(CommandError::from_message(operation, "AI 任务标识无效"));
    }
    manager
        .get_task(&task_id)
        .map_err(|error| CommandError::from_message(operation, error))
}

#[tauri::command]
pub(crate) fn ai_task_plan_decide(
    manager: State<'_, AgentTaskManager>,
    request: AgentPlanDecisionRequest,
) -> CommandResult<()> {
    manager
        .decide_plan(request)
        .map_err(|error| CommandError::from_message("ai_task_plan_decide", error))
}

#[tauri::command]
pub(crate) fn ai_task_action_transition(
    app: AppHandle,
    manager: State<'_, AgentTaskManager>,
    request: AgentActionTransitionRequest,
) -> CommandResult<()> {
    let events = manager
        .transition_action(request)
        .map_err(|error| CommandError::from_message("ai_task_action_transition", error))?;
    emit_task_events(&app, events);
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_task_command_observe(
    app: AppHandle,
    manager: State<'_, AgentTaskManager>,
    ssh_manager: State<'_, crate::ssh::SshSessionManager>,
    request: AgentCommandObservationRequest,
) -> CommandResult<()> {
    let task_id = request.task_id.clone();
    let action_id = request.action_id.clone();
    let events = manager
        .observe_command_execution(request)
        .map_err(|error| CommandError::from_message("ai_task_command_observe", error))?;
    emit_task_events(&app, events);
    if let Some(pending) = manager
        .pending_business_verification(&task_id, &action_id)
        .map_err(|error| CommandError::from_message("ai_task_command_observe", error))?
    {
        let result = ssh_manager
            .verify_agent_condition(&pending.session_id, pending.verification.clone())
            .await;
        let events = manager
            .complete_business_verification(&pending, result)
            .map_err(|error| CommandError::from_message("ai_task_command_observe", error))?;
        emit_task_events(&app, events);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};

    use super::{
        AgentActionIntent, AgentActionRisk, AgentActionState, AgentActionStatus,
        AgentActionTransition, AgentActionTransitionRequest, AgentApprovalMode,
        AgentCommandObservationPhase, AgentCommandObservationRequest, AgentPlan, AgentPlanDecision,
        AgentPlanDecisionKind, AgentPlanDecisionRequest, AgentPlanStatus, AgentPlanStep,
        AgentPlanStepStatus, AgentRecoveryRecommendation, AgentRecoveryStatus,
        AgentRepairStopReason, AgentTaskContext, AgentTaskEventKind, AgentTaskManager,
        AgentTaskStatus, AgentTrustedVerification, AgentVerificationEvidenceKind,
        AgentVerificationStatus, AgentWritableFile,
    };
    use crate::agent_approvals::ApprovalScope;
    use crate::agent_verification::AgentBusinessVerificationResult;

    fn context() -> AgentTaskContext {
        AgentTaskContext {
            id: "task-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            host_id: "host-1".to_string(),
            terminal_session_id: Some("session-1".to_string()),
            current_directory: Some("/srv/app".to_string()),
            file_operation_directory: Some("/srv/app".to_string()),
            writable_files: vec![AgentWritableFile {
                path: "/etc/nginx.conf".to_string(),
                content: "server { listen 80; }".to_string(),
                size: 21,
            }],
            objective: "检查服务器状态".to_string(),
            approval_mode: AgentApprovalMode::OnRequest,
        }
    }

    fn network_plan() -> AgentPlan {
        AgentPlan {
            id: "plan-1".to_string(),
            description: Some("检查网络".to_string()),
            status: AgentPlanStatus::Pending,
            created_at: 1,
            steps: vec![AgentPlanStep {
                id: "call-1".to_string(),
                title: "Ping".to_string(),
                tool: "ping_target".to_string(),
                status: AgentPlanStepStatus::Pending,
                detail: Some("example.com".to_string()),
                reason: "检查连通性".to_string(),
                optional: false,
                depends_on: Vec::new(),
                summary: None,
                error: None,
                started_at: None,
                duration_ms: None,
            }],
        }
    }

    fn network_approval_requirements() -> HashMap<String, String> {
        HashMap::from([(
            "call-1".to_string(),
            "ping_target\0{\"target\":\"example.com\"}".to_string(),
        )])
    }

    fn network_approval_scope() -> ApprovalScope {
        ApprovalScope {
            task_id: "task-1".to_string(),
            plan_id: "plan-1".to_string(),
            call_id: "call-1".to_string(),
            host_id: "host-1".to_string(),
            session_id: Some("session-1".to_string()),
            current_directory: Some("/srv/app".to_string()),
            action_fingerprint: "ping_target\0{\"target\":\"example.com\"}".to_string(),
        }
    }

    fn file_edit_intent() -> AgentActionIntent {
        AgentActionIntent {
            id: "edit-1".to_string(),
            tool: "propose_file_edit".to_string(),
            arguments: serde_json::json!({
                "content": "server {}",
                "path": "/etc/nginx.conf",
            }),
            reason: "修改 Nginx 配置".to_string(),
            expected_effect: "替换远程配置文件".to_string(),
            risk: AgentActionRisk::ReversibleWrite,
        }
    }

    fn terminal_command_intent() -> AgentActionIntent {
        AgentActionIntent {
            id: "command-1".to_string(),
            tool: "propose_terminal_command".to_string(),
            arguments: serde_json::json!({
                "command": "systemctl status nginx",
                "purpose": "检查 Nginx 状态",
            }),
            reason: "需要检查服务状态".to_string(),
            expected_effect: "将命令填入绑定的终端".to_string(),
            risk: AgentActionRisk::Elevated,
        }
    }

    fn verified_terminal_command_intent() -> AgentActionIntent {
        let mut intent = terminal_command_intent();
        intent.arguments["verification"] = serde_json::json!({
            "kind": "service_active",
            "service": "nginx.service",
        });
        intent
    }

    fn rename_intent(target_path: &str) -> AgentActionIntent {
        AgentActionIntent {
            id: "rename-1".to_string(),
            tool: "propose_file_operation".to_string(),
            arguments: serde_json::json!({
                "operation": "rename",
                "path": "/etc/nginx.conf",
                "targetPath": target_path,
            }),
            reason: "重命名 Nginx 配置".to_string(),
            expected_effect: "重命名远程配置文件".to_string(),
            risk: AgentActionRisk::ReversibleWrite,
        }
    }

    fn transition(transition: AgentActionTransition) -> AgentActionTransitionRequest {
        AgentActionTransitionRequest {
            task_id: "task-1".to_string(),
            action_id: "edit-1".to_string(),
            transition,
            summary: None,
            error: None,
        }
    }

    fn command_observation(phase: AgentCommandObservationPhase) -> AgentCommandObservationRequest {
        AgentCommandObservationRequest {
            task_id: "task-1".to_string(),
            action_id: "command-1".to_string(),
            host_id: "host-1".to_string(),
            session_id: "session-1".to_string(),
            submission_id: "submission-1".to_string(),
            phase,
            command: "systemctl status nginx".to_string(),
            exit_code: None,
            duration_ms: None,
            reason: None,
        }
    }

    fn serialized_values<T: SerializeValues>(values: &[T]) -> BTreeSet<String> {
        values.iter().map(SerializeValues::serialized).collect()
    }

    trait SerializeValues {
        fn serialized(&self) -> String;
    }

    impl<T: serde::Serialize> SerializeValues for T {
        fn serialized(&self) -> String {
            serde_json::to_value(self)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        }
    }

    #[test]
    fn task_events_have_monotonic_sequences_and_terminal_state() {
        let manager = AgentTaskManager::default();
        let started = manager.begin_model_turn(&context()).unwrap();
        assert_eq!(started.len(), 2);
        assert_eq!(started[0].sequence, 1);
        assert_eq!(started[1].sequence, 2);
        assert_eq!(started[1].task.iteration, 1);
        assert_eq!(started[1].task.status, AgentTaskStatus::Running);

        let waiting = manager.finish_model_turn("task-1", true).unwrap();
        assert_eq!(waiting[0].sequence, 3);
        let second = manager.begin_model_turn(&context()).unwrap();
        assert_eq!(second[0].sequence, 4);
        assert_eq!(second[0].task.iteration, 2);
        let completed = manager.finish_model_turn("task-1", false).unwrap();
        assert_eq!(completed[0].sequence, 5);
        assert_eq!(completed[0].task.status, AgentTaskStatus::Completed);
    }

    #[test]
    fn action_lifecycle_supports_conflict_retry_success_and_rollback() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();

        let proposed = manager
            .register_actions("task-1", vec![file_edit_intent()])
            .unwrap();
        assert_eq!(proposed[0].kind, AgentTaskEventKind::ActionProposed);
        assert_eq!(proposed[0].action_id.as_deref(), Some("edit-1"));
        assert_eq!(proposed[0].task.status, AgentTaskStatus::AwaitingApproval);
        assert_eq!(
            proposed[0].task.actions[0].status,
            AgentActionStatus::Pending
        );
        let serialized = serde_json::to_value(&proposed[0].task).unwrap();
        assert!(serialized["actions"][0].get("arguments").is_none());
        assert!(serialized["actions"][0]
            .get("commandSubmissionId")
            .is_none());
        assert!(serialized.get("writableFiles").is_none());
        assert!(serialized.get("fileOperationDirectory").is_none());

        let model_completed = manager.finish_model_turn("task-1", false).unwrap();
        assert_eq!(
            model_completed[0].kind,
            AgentTaskEventKind::ModelTurnCompleted
        );
        assert!(model_completed[0].task.model_completed);
        assert_eq!(
            model_completed[0].task.status,
            AgentTaskStatus::AwaitingApproval
        );

        let started = manager
            .transition_action(transition(AgentActionTransition::Start))
            .unwrap();
        assert_eq!(started.len(), 2);
        assert_eq!(started[0].kind, AgentTaskEventKind::ActionApproved);
        assert_eq!(started[1].kind, AgentTaskEventKind::ActionStarted);

        let conflicted = manager
            .transition_action(AgentActionTransitionRequest {
                error: Some("远程文件已经变化".to_string()),
                ..transition(AgentActionTransition::Conflict)
            })
            .unwrap();
        assert_eq!(conflicted[0].kind, AgentTaskEventKind::ActionConflicted);
        assert_eq!(conflicted[1].kind, AgentTaskEventKind::TaskCompleted);
        assert_eq!(
            conflicted[1].task.actions[0].status,
            AgentActionStatus::Conflict
        );

        let retried = manager
            .transition_action(transition(AgentActionTransition::Retry))
            .unwrap();
        assert_eq!(retried[0].kind, AgentTaskEventKind::ActionRetried);
        assert_eq!(retried[0].task.status, AgentTaskStatus::AwaitingApproval);
        assert!(retried[0].task.result.is_none());

        manager
            .transition_action(transition(AgentActionTransition::Start))
            .unwrap();
        let succeeded = manager
            .transition_action(AgentActionTransitionRequest {
                summary: Some("配置文件已写入".to_string()),
                ..transition(AgentActionTransition::Succeed)
            })
            .unwrap();
        assert_eq!(succeeded[0].kind, AgentTaskEventKind::ActionSucceeded);
        assert_eq!(succeeded[1].kind, AgentTaskEventKind::TaskCompleted);
        assert!(!succeeded[1].task.result.as_ref().unwrap().verified);
        assert_eq!(
            succeeded[1]
                .task
                .result
                .as_ref()
                .unwrap()
                .verification_status,
            AgentVerificationStatus::Unverified
        );

        let rollback_started = manager
            .transition_action(transition(AgentActionTransition::RollbackStart))
            .unwrap();
        assert_eq!(
            rollback_started[0].kind,
            AgentTaskEventKind::ActionRollbackStarted
        );
        assert_eq!(rollback_started[0].task.status, AgentTaskStatus::Running);
        let rolled_back = manager
            .transition_action(transition(AgentActionTransition::RolledBack))
            .unwrap();
        assert_eq!(rolled_back[0].kind, AgentTaskEventKind::ActionRolledBack);
        assert_eq!(rolled_back[1].kind, AgentTaskEventKind::TaskCompleted);
        assert_eq!(
            rolled_back[1].task.actions[0].status,
            AgentActionStatus::RolledBack
        );
    }

    #[test]
    fn trusted_file_execution_requires_confirmation_and_uses_private_snapshot() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![file_edit_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();

        assert_eq!(
            manager
                .authorize_action_execution("task-1", "edit-1", false, false, None)
                .unwrap_err(),
            "该 AI 动作需要本次用户审批"
        );

        let (action, events) = manager
            .authorize_action_execution(
                "task-1",
                "edit-1",
                false,
                true,
                Some("server { listen 443; }".to_string()),
            )
            .unwrap();
        assert_eq!(action.arguments["path"], "/etc/nginx.conf");
        assert_eq!(action.arguments["content"], "server { listen 443; }");
        assert_eq!(action.arguments["originalContent"], "server { listen 80; }");
        assert_eq!(events[0].kind, AgentTaskEventKind::ActionApproved);
        assert_eq!(events[1].kind, AgentTaskEventKind::ActionStarted);
        assert_eq!(events[1].task.actions[0].status, AgentActionStatus::Running);
        assert!(manager
            .authorize_action_execution("task-1", "edit-1", false, true, None)
            .is_err());
        assert_eq!(
            manager
                .complete_trusted_action_execution(
                    "task-1",
                    "edit-1",
                    false,
                    AgentTrustedVerification::RemotePathState,
                )
                .unwrap_err(),
            "AI 动作与可信验证结果不匹配"
        );

        let completed = manager
            .complete_trusted_action_execution(
                "task-1",
                "edit-1",
                false,
                AgentTrustedVerification::RemoteContentMatch,
            )
            .unwrap();
        assert_eq!(completed.len(), 3);
        assert_eq!(completed[0].kind, AgentTaskEventKind::ActionSucceeded);
        assert_eq!(
            completed[1].kind,
            AgentTaskEventKind::ActionVerificationRecorded
        );
        assert_eq!(
            completed[1].task.actions[0].verification_status,
            AgentVerificationStatus::Verified
        );
        assert_eq!(completed[2].kind, AgentTaskEventKind::TaskCompleted);
        assert!(completed[2].task.result.as_ref().unwrap().verified);
        assert_eq!(
            completed[2]
                .task
                .result
                .as_ref()
                .unwrap()
                .verification_status,
            AgentVerificationStatus::Verified
        );
        let (rollback, _) = manager
            .authorize_action_execution("task-1", "edit-1", true, true, None)
            .unwrap();
        assert_eq!(rollback.arguments["content"], "server { listen 443; }");
    }

    #[test]
    fn trusted_file_scope_rejects_cross_directory_rename() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        assert_eq!(
            manager
                .register_actions("task-1", vec![rename_intent("/tmp/nginx.conf")])
                .unwrap_err(),
            "AI 重命名目标必须与源文件位于同一目录"
        );
        assert!(manager
            .register_actions("task-1", vec![rename_intent("/etc/nginx.backup")])
            .is_ok());
    }

    #[test]
    fn terminal_commands_still_require_confirmation_in_full_access_mode() {
        let manager = AgentTaskManager::default();
        let mut full_access = context();
        full_access.approval_mode = AgentApprovalMode::FullAccess;
        manager.begin_model_turn(&full_access).unwrap();
        manager
            .register_actions("task-1", vec![terminal_command_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();

        assert_eq!(
            manager
                .authorize_action_execution("task-1", "command-1", false, false, None)
                .unwrap_err(),
            "该 AI 动作需要本次用户审批"
        );
        let (action, events) = manager
            .authorize_action_execution("task-1", "command-1", false, true, None)
            .unwrap();
        assert!(action.prepares_command);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, AgentTaskEventKind::ActionApproved);
        assert_eq!(
            events[0].task.actions[0].status,
            AgentActionStatus::Approved
        );
    }

    #[test]
    fn terminal_command_observations_drive_the_trusted_lifecycle() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![terminal_command_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();
        manager
            .authorize_action_execution("task-1", "command-1", false, true, None)
            .unwrap();

        let submitted = manager
            .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
            .unwrap();
        assert_eq!(submitted.len(), 1);
        assert_eq!(submitted[0].kind, AgentTaskEventKind::ActionStarted);
        assert_eq!(
            submitted[0].task.actions[0].status,
            AgentActionStatus::Running
        );
        assert!(manager
            .observe_command_execution(
                command_observation(AgentCommandObservationPhase::Submitted,)
            )
            .unwrap()
            .is_empty());

        let mut completed = command_observation(AgentCommandObservationPhase::Completed);
        completed.exit_code = Some(0);
        completed.duration_ms = Some(1_250);
        let completed = manager.observe_command_execution(completed).unwrap();
        assert_eq!(completed.len(), 3);
        assert_eq!(completed[0].kind, AgentTaskEventKind::ActionSucceeded);
        assert_eq!(
            completed[1].kind,
            AgentTaskEventKind::ActionVerificationRecorded
        );
        assert_eq!(completed[1].task.actions[0].duration_ms, Some(1_250));
        assert_eq!(
            completed[1].task.actions[0].status,
            AgentActionStatus::Succeeded
        );
        assert_eq!(
            completed[1].task.actions[0].verification_status,
            AgentVerificationStatus::Unverified
        );
        assert_eq!(completed[2].kind, AgentTaskEventKind::TaskCompleted);
        assert!(!completed[2].task.result.as_ref().unwrap().verified);
        assert_eq!(
            completed[2]
                .task
                .result
                .as_ref()
                .unwrap()
                .verification_status,
            AgentVerificationStatus::Unverified
        );
    }

    #[test]
    fn registered_business_verification_completes_a_successful_command() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![verified_terminal_command_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();
        manager
            .authorize_action_execution("task-1", "command-1", false, true, None)
            .unwrap();
        manager
            .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
            .unwrap();

        let mut completed = command_observation(AgentCommandObservationPhase::Completed);
        completed.exit_code = Some(0);
        completed.duration_ms = Some(250);
        let events = manager.observe_command_execution(completed).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].task.status, AgentTaskStatus::Verifying);
        assert_eq!(
            events[1].task.actions[0].verification_status,
            AgentVerificationStatus::Pending
        );

        let pending = manager
            .pending_business_verification("task-1", "command-1")
            .unwrap()
            .unwrap();
        let events = manager
            .complete_business_verification(
                &pending,
                Ok(AgentBusinessVerificationResult {
                    passed: true,
                    summary: "服务 nginx.service 处于运行状态".to_string(),
                }),
            )
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].task.actions[0].verification_status,
            AgentVerificationStatus::Verified
        );
        assert_eq!(
            events[0].task.actions[0].verification_evidence[1].kind,
            AgentVerificationEvidenceKind::ServiceStatus
        );
        assert_eq!(events[1].kind, AgentTaskEventKind::TaskCompleted);
        assert!(events[1].task.result.as_ref().unwrap().verified);
    }

    #[test]
    fn repair_budget_allows_two_retries_and_then_stops() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![verified_terminal_command_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();

        for attempt in 0_u8..=2 {
            manager
                .authorize_action_execution("task-1", "command-1", false, true, None)
                .unwrap();
            let mut submitted = command_observation(AgentCommandObservationPhase::Submitted);
            submitted.submission_id = format!("submission-{attempt}");
            manager.observe_command_execution(submitted).unwrap();
            let mut completed = command_observation(AgentCommandObservationPhase::Completed);
            completed.submission_id = format!("submission-{attempt}");
            completed.exit_code = Some(0);
            completed.duration_ms = Some(100);
            manager.observe_command_execution(completed).unwrap();
            let pending = manager
                .pending_business_verification("task-1", "command-1")
                .unwrap()
                .unwrap();
            let events = manager
                .complete_business_verification(
                    &pending,
                    Ok(AgentBusinessVerificationResult {
                        passed: false,
                        summary: "服务 nginx.service 未处于运行状态".to_string(),
                    }),
                )
                .unwrap();
            let task = &events.last().unwrap().task;
            if attempt < 2 {
                assert_eq!(
                    task.repair_stop_reason,
                    Some(AgentRepairStopReason::VerificationFailed)
                );
                assert_eq!(
                    task.actions[0]
                        .recovery_state
                        .as_ref()
                        .unwrap()
                        .recommendation,
                    AgentRecoveryRecommendation::Retry
                );
                let retried = manager
                    .transition_action(AgentActionTransitionRequest {
                        task_id: "task-1".to_string(),
                        action_id: "command-1".to_string(),
                        transition: AgentActionTransition::Retry,
                        summary: None,
                        error: None,
                    })
                    .unwrap();
                assert_eq!(retried[0].task.repair_attempts, attempt + 1);
                assert_eq!(
                    retried[0].task.actions[0]
                        .recovery_state
                        .as_ref()
                        .unwrap()
                        .status,
                    AgentRecoveryStatus::Running
                );
            } else {
                assert_eq!(task.repair_attempts, 2);
                assert_eq!(
                    task.repair_stop_reason,
                    Some(AgentRepairStopReason::RepairBudgetExhausted)
                );
                assert_eq!(
                    task.result.as_ref().unwrap().stop_reason.as_deref(),
                    Some("repair_budget_exhausted")
                );
                let recovery = task.actions[0].recovery_state.as_ref().unwrap();
                assert_eq!(
                    recovery.recommendation,
                    AgentRecoveryRecommendation::ManualReview
                );
                assert_eq!(recovery.status, AgentRecoveryStatus::Suggested);
            }
        }

        assert_eq!(
            manager
                .transition_action(AgentActionTransitionRequest {
                    task_id: "task-1".to_string(),
                    action_id: "command-1".to_string(),
                    transition: AgentActionTransition::Retry,
                    summary: None,
                    error: None,
                })
                .unwrap_err(),
            "AI 任务修复次数已达到上限"
        );
    }

    #[test]
    fn trusted_rollback_records_verified_recovery_state() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![file_edit_intent()])
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();
        manager
            .authorize_action_execution("task-1", "edit-1", false, true, None)
            .unwrap();
        manager
            .complete_trusted_action_execution(
                "task-1",
                "edit-1",
                false,
                AgentTrustedVerification::RemoteContentMatch,
            )
            .unwrap();
        manager
            .authorize_action_execution("task-1", "edit-1", true, true, None)
            .unwrap();
        let events = manager
            .complete_trusted_action_execution(
                "task-1",
                "edit-1",
                true,
                AgentTrustedVerification::RemoteContentMatch,
            )
            .unwrap();
        let recovery = events[1].task.actions[0].recovery_state.as_ref().unwrap();
        assert_eq!(
            recovery.recommendation,
            AgentRecoveryRecommendation::Rollback
        );
        assert_eq!(recovery.status, AgentRecoveryStatus::Verified);
        assert_eq!(
            events[1].task.actions[0]
                .verification_evidence
                .last()
                .unwrap()
                .kind,
            AgentVerificationEvidenceKind::RecoveryStateMatch
        );
    }

    #[test]
    fn failed_file_verification_recommends_rollback() {
        let mut action = AgentActionState::from_intent(file_edit_intent());
        action.status = AgentActionStatus::Succeeded;
        action.verification_status = AgentVerificationStatus::Failed;
        action.suggest_repair(true, 42);

        let recovery = action.recovery_state.as_ref().unwrap();
        assert_eq!(
            recovery.recommendation,
            AgentRecoveryRecommendation::Rollback
        );
        assert_eq!(recovery.status, AgentRecoveryStatus::Suggested);
        assert_eq!(recovery.updated_at, 42);
    }

    #[test]
    fn terminal_command_observations_support_batched_failures_and_reject_mismatches() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![terminal_command_intent()])
            .unwrap();
        manager
            .authorize_action_execution("task-1", "command-1", false, true, None)
            .unwrap();

        let mut mismatched = command_observation(AgentCommandObservationPhase::Submitted);
        mismatched.command = "systemctl restart nginx".to_string();
        assert_eq!(
            manager.observe_command_execution(mismatched).unwrap_err(),
            "终端提交与 AI 命令提案不匹配"
        );

        let mut unavailable = command_observation(AgentCommandObservationPhase::Unavailable);
        unavailable.duration_ms = Some(0);
        unavailable.reason = Some("Shell Integration 尚未就绪".to_string());
        let events = manager.observe_command_execution(unavailable).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, AgentTaskEventKind::ActionStarted);
        assert_eq!(events[1].kind, AgentTaskEventKind::ActionFailed);
        assert_eq!(
            events[2].kind,
            AgentTaskEventKind::ActionVerificationRecorded
        );
        assert_eq!(
            events[2].task.actions[0].error.as_deref(),
            Some("Shell Integration 尚未就绪")
        );
    }

    #[test]
    fn task_result_reports_partial_verification_for_mixed_evidence() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions(
                "task-1",
                vec![file_edit_intent(), terminal_command_intent()],
            )
            .unwrap();
        manager.finish_model_turn("task-1", false).unwrap();

        manager
            .authorize_action_execution("task-1", "edit-1", false, true, None)
            .unwrap();
        manager
            .complete_trusted_action_execution(
                "task-1",
                "edit-1",
                false,
                AgentTrustedVerification::RemoteContentMatch,
            )
            .unwrap();
        manager
            .authorize_action_execution("task-1", "command-1", false, true, None)
            .unwrap();
        let mut completed = command_observation(AgentCommandObservationPhase::Completed);
        completed.exit_code = Some(0);
        completed.duration_ms = Some(250);
        let events = manager.observe_command_execution(completed).unwrap();
        let result = events.last().unwrap().task.result.as_ref().unwrap();
        assert!(!result.verified);
        assert_eq!(result.verification_status, AgentVerificationStatus::Partial);
    }

    #[test]
    fn action_lifecycle_rejects_invalid_transitions() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        manager
            .register_actions("task-1", vec![file_edit_intent()])
            .unwrap();

        assert_eq!(
            manager
                .transition_action(transition(AgentActionTransition::Succeed))
                .unwrap_err(),
            "AI 动作当前不能标记为成功"
        );
    }

    #[test]
    fn task_scope_is_immutable_across_model_turns() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let mut changed = context();
        changed.host_id = "host-2".to_string();
        assert_eq!(
            manager.begin_model_turn(&changed).unwrap_err(),
            "AI 任务作用域与已有任务不一致"
        );
    }

    #[test]
    fn cancellation_is_terminal_and_idempotent() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let cancelled = manager.cancel_task("task-1").unwrap();
        assert_eq!(cancelled[0].task.status, AgentTaskStatus::Cancelled);
        assert!(manager.cancel_task("task-1").unwrap().is_empty());
        assert!(manager
            .fail_task("task-1", "late failure")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn disconnected_tasks_pause_and_resume_without_changing_scope() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();

        let paused = manager
            .pause_disconnected("task-1", "SSH 连接已断开，等待重连")
            .unwrap();
        assert_eq!(paused[0].kind, AgentTaskEventKind::TaskPaused);
        assert_eq!(paused[0].task.status, AgentTaskStatus::PausedDisconnected);
        assert_eq!(
            paused[0].task.terminal_session_id.as_deref(),
            Some("session-1")
        );
        assert!(manager
            .pause_disconnected("task-1", "重复断线事件")
            .unwrap()
            .is_empty());

        let resumed = manager.resume_disconnected("task-1").unwrap();
        assert_eq!(resumed[0].kind, AgentTaskEventKind::TaskResumed);
        assert_eq!(resumed[0].task.status, AgentTaskStatus::Running);
        assert_eq!(
            resumed[0].task.terminal_session_id.as_deref(),
            Some("session-1")
        );
        assert!(manager.resume_disconnected("task-1").unwrap().is_empty());
    }

    #[test]
    fn cancelling_a_paused_task_cancels_its_unfinished_plan() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let mut plan = AgentPlan {
            id: "plan-1".to_string(),
            description: None,
            status: AgentPlanStatus::Running,
            created_at: 1,
            steps: vec![AgentPlanStep {
                id: "call-1".to_string(),
                title: "读取状态".to_string(),
                tool: "get_server_status".to_string(),
                status: AgentPlanStepStatus::InProgress,
                detail: None,
                reason: "检查服务器".to_string(),
                optional: false,
                depends_on: Vec::new(),
                summary: None,
                error: None,
                started_at: Some(1),
                duration_ms: None,
            }],
        };
        manager.start_plan("task-1", plan.clone()).unwrap();
        manager
            .pause_disconnected("task-1", "SSH 连接已断开")
            .unwrap();

        let cancelled = manager.cancel_task("task-1").unwrap();
        plan = cancelled[0].task.plan.clone().unwrap();
        assert_eq!(plan.status, AgentPlanStatus::Cancelled);
        assert_eq!(plan.steps[0].status, AgentPlanStepStatus::Skipped);
        assert_eq!(cancelled[0].task.status, AgentTaskStatus::Cancelled);
    }

    #[test]
    fn plan_decisions_are_scoped_to_the_active_task_and_plan() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let (receiver, events) = manager
            .set_plan("task-1", network_plan(), network_approval_requirements())
            .unwrap();
        assert_eq!(events[0].kind, AgentTaskEventKind::PlanCreated);
        manager
            .decide_plan(AgentPlanDecisionRequest {
                task_id: "task-1".to_string(),
                plan_id: "plan-1".to_string(),
                decision: AgentPlanDecisionKind::Approve,
                selected_call_ids: vec!["call-1".to_string()],
            })
            .unwrap();
        let decision = receiver.borrow().clone();
        let AgentPlanDecision::Approve(approval) = decision else {
            panic!("expected an approved plan");
        };
        assert_eq!(approval.selected_call_ids(), &["call-1".to_string()]);
        let credential = approval.credential_for("call-1").unwrap();
        manager
            .consume_approval(credential, network_approval_scope())
            .unwrap();
        assert_eq!(
            manager
                .consume_approval(credential, network_approval_scope())
                .unwrap_err(),
            "AI 审批凭证不存在或已被消费"
        );
        assert_eq!(
            manager
                .decide_plan(AgentPlanDecisionRequest {
                    task_id: "task-1".to_string(),
                    plan_id: "plan-1".to_string(),
                    decision: AgentPlanDecisionKind::Approve,
                    selected_call_ids: vec!["call-1".to_string()],
                })
                .unwrap_err(),
            "AI 计划已经作出决定"
        );
        assert_eq!(
            manager
                .decide_plan(AgentPlanDecisionRequest {
                    task_id: "task-1".to_string(),
                    plan_id: "other-plan".to_string(),
                    decision: AgentPlanDecisionKind::Reject,
                    selected_call_ids: Vec::new(),
                })
                .unwrap_err(),
            "AI 计划不存在"
        );
    }

    #[test]
    fn disconnect_revokes_unconsumed_plan_approvals() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let (receiver, _) = manager
            .set_plan("task-1", network_plan(), network_approval_requirements())
            .unwrap();
        manager
            .decide_plan(AgentPlanDecisionRequest {
                task_id: "task-1".to_string(),
                plan_id: "plan-1".to_string(),
                decision: AgentPlanDecisionKind::Approve,
                selected_call_ids: vec!["call-1".to_string()],
            })
            .unwrap();
        let AgentPlanDecision::Approve(approval) = receiver.borrow().clone() else {
            panic!("expected an approved plan");
        };
        manager
            .pause_disconnected("task-1", "SSH 连接已断开")
            .unwrap();
        assert_eq!(
            manager
                .consume_approval(
                    approval.credential_for("call-1").unwrap(),
                    network_approval_scope(),
                )
                .unwrap_err(),
            "AI 审批凭证不存在或已被消费"
        );
    }

    #[test]
    fn serialized_enums_match_the_shared_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/contract.json")).unwrap();
        let contract_keys = |name: &str| {
            contract[name]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(
            serialized_values(&[
                AgentTaskStatus::Understanding,
                AgentTaskStatus::GatheringContext,
                AgentTaskStatus::Planning,
                AgentTaskStatus::Running,
                AgentTaskStatus::AwaitingApproval,
                AgentTaskStatus::AwaitingUserInput,
                AgentTaskStatus::Verifying,
                AgentTaskStatus::Paused,
                AgentTaskStatus::PausedDisconnected,
                AgentTaskStatus::Completed,
                AgentTaskStatus::Failed,
                AgentTaskStatus::Cancelled,
            ]),
            contract_keys("agentTaskStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentTaskEventKind::TaskCreated,
                AgentTaskEventKind::ModelTurnStarted,
                AgentTaskEventKind::ModelTurnCompleted,
                AgentTaskEventKind::PlanCreated,
                AgentTaskEventKind::PlanStarted,
                AgentTaskEventKind::PlanUpdated,
                AgentTaskEventKind::PlanCompleted,
                AgentTaskEventKind::ActionProposed,
                AgentTaskEventKind::ActionApproved,
                AgentTaskEventKind::ActionRejected,
                AgentTaskEventKind::ActionStarted,
                AgentTaskEventKind::ActionSucceeded,
                AgentTaskEventKind::ActionConflicted,
                AgentTaskEventKind::ActionFailed,
                AgentTaskEventKind::ActionRollbackStarted,
                AgentTaskEventKind::ActionRolledBack,
                AgentTaskEventKind::ActionRollbackConflicted,
                AgentTaskEventKind::ActionRollbackFailed,
                AgentTaskEventKind::ActionRetried,
                AgentTaskEventKind::ActionVerificationRecorded,
                AgentTaskEventKind::TaskPaused,
                AgentTaskEventKind::TaskResumed,
                AgentTaskEventKind::TaskCompleted,
                AgentTaskEventKind::TaskFailed,
                AgentTaskEventKind::TaskCancelled,
            ]),
            contract_keys("agentTaskEventKinds")
        );
        assert_eq!(
            serialized_values(&[
                AgentPlanStepStatus::Pending,
                AgentPlanStepStatus::InProgress,
                AgentPlanStepStatus::Completed,
                AgentPlanStepStatus::Skipped,
                AgentPlanStepStatus::Failed,
            ]),
            contract_keys("agentPlanStepStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentPlanStatus::Pending,
                AgentPlanStatus::Running,
                AgentPlanStatus::Completed,
                AgentPlanStatus::Partial,
                AgentPlanStatus::Cancelled,
            ]),
            contract_keys("agentPlanStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentApprovalMode::OnRequest,
                AgentApprovalMode::AutoSafe,
                AgentApprovalMode::FullAccess,
            ]),
            contract_keys("agentApprovalModes")
        );
        assert_eq!(
            serialized_values(&[
                AgentActionRisk::ReadOnly,
                AgentActionRisk::ReversibleWrite,
                AgentActionRisk::Elevated,
                AgentActionRisk::Critical,
            ]),
            contract_keys("agentActionRisks")
        );
        assert_eq!(
            serialized_values(&[
                AgentActionStatus::Pending,
                AgentActionStatus::Approved,
                AgentActionStatus::Running,
                AgentActionStatus::Succeeded,
                AgentActionStatus::Conflict,
                AgentActionStatus::Failed,
                AgentActionStatus::Rejected,
                AgentActionStatus::RollingBack,
                AgentActionStatus::RolledBack,
                AgentActionStatus::RollbackConflict,
                AgentActionStatus::RollbackFailed,
                AgentActionStatus::Cancelled,
            ]),
            contract_keys("agentActionStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentActionTransition::Approve,
                AgentActionTransition::Reject,
                AgentActionTransition::Start,
                AgentActionTransition::Succeed,
                AgentActionTransition::Conflict,
                AgentActionTransition::Fail,
                AgentActionTransition::RollbackStart,
                AgentActionTransition::RolledBack,
                AgentActionTransition::Retry,
            ]),
            contract_keys("agentActionTransitions")
        );
        assert_eq!(
            serialized_values(&[
                AgentVerificationStatus::Pending,
                AgentVerificationStatus::Verified,
                AgentVerificationStatus::Partial,
                AgentVerificationStatus::Unverified,
                AgentVerificationStatus::Failed,
                AgentVerificationStatus::NotApplicable,
            ]),
            contract_keys("agentVerificationStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentRepairStopReason::VerificationFailed,
                AgentRepairStopReason::ActionFailed,
                AgentRepairStopReason::RepairBudgetExhausted,
            ]),
            contract_keys("agentRepairStopReasons")
        );
        assert_eq!(
            serialized_values(&[
                AgentRecoveryRecommendation::Rollback,
                AgentRecoveryRecommendation::Retry,
                AgentRecoveryRecommendation::ManualReview,
            ]),
            contract_keys("agentRecoveryRecommendations")
        );
        assert_eq!(
            serialized_values(&[
                AgentRecoveryStatus::Suggested,
                AgentRecoveryStatus::Running,
                AgentRecoveryStatus::Verified,
                AgentRecoveryStatus::Unverified,
                AgentRecoveryStatus::Failed,
            ]),
            contract_keys("agentRecoveryStatuses")
        );
        assert_eq!(
            serialized_values(&[
                AgentVerificationEvidenceKind::RemoteContentMatch,
                AgentVerificationEvidenceKind::RemotePathState,
                AgentVerificationEvidenceKind::RecoveryStateMatch,
                AgentVerificationEvidenceKind::CommandExitStatus,
                AgentVerificationEvidenceKind::ServiceStatus,
                AgentVerificationEvidenceKind::PortListening,
                AgentVerificationEvidenceKind::ConfigSyntax,
                AgentVerificationEvidenceKind::ResultUnavailable,
            ]),
            contract_keys("agentVerificationEvidenceKinds")
        );
    }
}
