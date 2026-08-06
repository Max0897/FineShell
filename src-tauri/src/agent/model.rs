use super::*;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentApprovalMode {
    OnRequest,
    AutoSafe,
    FullAccess,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
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
    pub(super) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentPlanStatus {
    Pending,
    Running,
    Completed,
    Partial,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPlan {
    pub(crate) id: String,
    pub(crate) description: Option<String>,
    pub(crate) status: AgentPlanStatus,
    pub(crate) created_at: u64,
    pub(crate) steps: Vec<AgentPlanStep>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AgentActionRisk {
    ReadOnly,
    LowRisk,
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
    pub(super) path: String,
    pub(super) content: String,
    pub(super) size: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentCommandExecutionPhase {
    Connecting,
    Running,
    Cancelling,
    Completed,
    Failed,
    Interrupted,
}

impl AgentCommandExecutionPhase {
    pub(super) fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}

#[derive(Default)]
pub(crate) struct AgentCommandOutputSnapshot {
    pub(crate) output_excerpt: Option<String>,
    pub(crate) output_truncated: bool,
    pub(crate) stdout_excerpt: Option<String>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_excerpt: Option<String>,
    pub(crate) stderr_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCommandExecutionState {
    pub(super) submission_id: String,
    pub(super) phase: AgentCommandExecutionPhase,
    pub(super) output_excerpt: Option<String>,
    pub(super) output_truncated: bool,
    #[serde(default)]
    pub(super) stdout_excerpt: Option<String>,
    #[serde(default)]
    pub(super) stdout_truncated: bool,
    #[serde(default)]
    pub(super) stderr_excerpt: Option<String>,
    #[serde(default)]
    pub(super) stderr_truncated: bool,
    pub(super) exit_code: Option<u16>,
    pub(super) duration_ms: Option<u64>,
    pub(super) reason: Option<String>,
    pub(super) submitted_at: u64,
    pub(super) updated_at: u64,
    pub(super) completed_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentVerificationStatus {
    Pending,
    Verified,
    Partial,
    Unverified,
    Failed,
    NotApplicable,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRepairStopReason {
    VerificationFailed,
    ActionFailed,
    RepairBudgetExhausted,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRecoveryRecommendation {
    Rollback,
    Retry,
    ManualReview,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRecoveryStatus {
    Suggested,
    Running,
    Verified,
    Unverified,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRecoveryState {
    pub(super) recommendation: AgentRecoveryRecommendation,
    pub(super) status: AgentRecoveryStatus,
    pub(super) summary: String,
    pub(super) updated_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentVerificationEvidence {
    pub(super) kind: AgentVerificationEvidenceKind,
    pub(super) summary: String,
    pub(super) observed_at: u64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AgentTrustedVerification {
    RemoteContentMatch,
    RemotePathState,
}

impl AgentActionStatus {
    pub(super) fn is_unresolved(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Approved | Self::Running | Self::RollingBack
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionState {
    pub(super) id: String,
    pub(super) tool: String,
    pub(super) reason: String,
    pub(super) expected_effect: String,
    pub(super) risk: AgentActionRisk,
    pub(super) status: AgentActionStatus,
    pub(super) summary: Option<String>,
    pub(super) error: Option<String>,
    pub(super) started_at: Option<u64>,
    pub(super) completed_at: Option<u64>,
    pub(super) duration_ms: Option<u64>,
    pub(super) verification_status: AgentVerificationStatus,
    pub(super) verification_evidence: Vec<AgentVerificationEvidence>,
    pub(super) recovery_state: Option<AgentRecoveryState>,
    #[serde(default)]
    pub(super) command_execution: Option<AgentCommandExecutionState>,
    #[serde(default, skip_serializing)]
    pub(super) arguments: serde_json::Value,
    #[serde(default, skip_serializing)]
    pub(super) command_submission_id: Option<String>,
}

impl AgentActionState {
    pub(super) fn from_intent(intent: AgentActionIntent) -> Self {
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
            command_execution: None,
            command_submission_id: None,
        }
    }

    pub(super) fn record_verification(
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

    pub(super) fn update_recovery(
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

    pub(super) fn suggest_repair(&mut self, retry_available: bool, updated_at: u64) {
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

    pub(super) fn finish_repair_verification(&mut self, verified: bool, updated_at: u64) {
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskResult {
    pub(super) summary: String,
    pub(super) verified: bool,
    pub(super) verification_status: AgentVerificationStatus,
    pub(super) stop_reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskDiagnostics {
    pub(super) duration_ms: u64,
    pub(super) model_turn_count: u32,
    pub(super) plan_step_count: usize,
    pub(super) action_count: usize,
    pub(super) verification_evidence_count: usize,
    pub(super) repair_attempt_count: u8,
    pub(super) stop_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskContext {
    pub(super) id: String,
    pub(super) conversation_id: String,
    pub(super) host_id: String,
    pub(super) terminal_session_id: Option<String>,
    pub(super) current_directory: Option<String>,
    #[serde(default)]
    pub(super) file_operation_directory: Option<String>,
    #[serde(default)]
    pub(super) writable_files: Vec<AgentWritableFile>,
    pub(super) objective: String,
    pub(super) approval_mode: AgentApprovalMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTask {
    pub(super) id: String,
    pub(super) conversation_id: String,
    pub(super) host_id: String,
    pub(super) terminal_session_id: Option<String>,
    pub(super) current_directory: Option<String>,
    #[serde(default, skip_serializing)]
    pub(super) file_operation_directory: Option<String>,
    #[serde(default, skip_serializing)]
    pub(super) writable_files: Vec<AgentWritableFile>,
    pub(super) approval_mode: AgentApprovalMode,
    pub(super) status: AgentTaskStatus,
    pub(super) objective: String,
    pub(super) plan: Option<AgentPlan>,
    pub(super) active_step_id: Option<String>,
    pub(super) actions: Vec<AgentActionState>,
    pub(super) model_completed: bool,
    pub(super) iteration: u32,
    pub(super) repair_attempts: u8,
    pub(super) repair_limit: u8,
    pub(super) repair_stop_reason: Option<AgentRepairStopReason>,
    #[serde(default)]
    pub(super) diagnostics: AgentTaskDiagnostics,
    pub(super) last_event_sequence: u64,
    pub(super) result: Option<AgentTaskResult>,
    pub(super) error: Option<String>,
    pub(super) created_at: u64,
    pub(super) updated_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
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
    ActionProgress,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskEvent {
    pub(super) protocol_version: u16,
    pub(super) sequence: u64,
    pub(super) kind: AgentTaskEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) action_id: Option<String>,
    pub(super) task: AgentTask,
}

pub(crate) struct AgentTaskManager {
    pub(super) tasks: Mutex<HashMap<String, AgentTask>>,
    pub(super) events: Mutex<HashMap<String, VecDeque<AgentTaskEvent>>>,
    pub(super) storage_path: Mutex<Option<PathBuf>>,
    pub(super) plan_controls: Mutex<HashMap<String, AgentPlanControl>>,
    pub(super) approval_credentials: Mutex<ApprovalCredentialStore>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedAgentRuntime {
    pub(super) version: u8,
    pub(super) tasks: Vec<AgentTask>,
    pub(super) events: Vec<AgentTaskEvent>,
}

pub(crate) struct AgentPlanControl {
    pub(super) plan_id: String,
    pub(super) approval_requirements: HashMap<String, String>,
    pub(super) sender: watch::Sender<AgentPlanDecision>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentPlanApproval {
    pub(super) selected_call_ids: Vec<String>,
    pub(super) credentials: Vec<ApprovalCredential>,
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
    Reject(Option<String>),
    Stop,
}
