use std::collections::{BTreeSet, HashMap};

use super::{
    AgentActionExecutionKind, AgentActionIntent, AgentActionRisk, AgentActionState,
    AgentActionStatus, AgentActionTransition, AgentActionTransitionRequest, AgentApprovalMode,
    AgentCommandExecutionPhase, AgentCommandObservationPhase, AgentCommandObservationRequest,
    AgentCommandOutputSnapshot, AgentPlan, AgentPlanDecision, AgentPlanDecisionKind,
    AgentPlanDecisionRequest, AgentPlanStatus, AgentPlanStep, AgentPlanStepStatus,
    AgentRecoveryRecommendation, AgentRecoveryStatus, AgentRepairStopReason, AgentTaskContext,
    AgentTaskEventKind, AgentTaskManager, AgentTaskRecoveryDecision, AgentTaskRecoveryRequest,
    AgentTaskStatus, AgentTrustedVerification, AgentVerificationEvidenceKind,
    AgentVerificationStatus, AgentWritableFile, AGENT_RUNTIME_STATE_FILE,
};
use crate::agent_approvals::ApprovalScope;
use crate::agent_verification::AgentBusinessVerificationResult;

fn context() -> AgentTaskContext {
    AgentTaskContext {
        context_version: super::AGENT_CONTEXT_VERSION,
        context_captured_at: super::timestamp_ms(),
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
        tool: "execute_terminal_command".to_string(),
        arguments: serde_json::json!({
            "command": "systemctl status nginx",
            "purpose": "检查 Nginx 状态",
        }),
        reason: "需要检查服务状态".to_string(),
        expected_effect: "将命令填入绑定的终端".to_string(),
        risk: AgentActionRisk::Elevated,
    }
}

fn low_risk_terminal_command_intent() -> AgentActionIntent {
    let mut intent = terminal_command_intent();
    intent.risk = AgentActionRisk::LowRisk;
    intent
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

#[test]
fn persists_only_redacted_snapshots_and_replays_bounded_events() {
    let directory = std::env::temp_dir().join(format!(
        "fineshell-agent-state-{}-{}",
        std::process::id(),
        super::timestamp_ms()
    ));
    let path = directory.join(AGENT_RUNTIME_STATE_FILE);
    let manager = AgentTaskManager::default();
    manager.initialize_storage(path.clone()).unwrap();

    let mut task_context = context();
    task_context.objective = "使用 password=secret 修复 /etc/nginx.conf".to_string();
    let started = manager.begin_model_turn(&task_context).unwrap();
    manager.record_events(&started);
    let proposed = manager
        .register_actions("task-1", vec![file_edit_intent()])
        .unwrap();
    manager.record_events(&proposed);

    let persisted = std::fs::read_to_string(&path).unwrap();
    assert!(persisted.contains("任务内容已脱敏"));
    assert!(!persisted.contains("password=secret"));
    assert!(!persisted.contains("/etc/nginx.conf"));
    assert!(!persisted.contains("server {}"));

    let restored = AgentTaskManager::default();
    restored.initialize_storage(path.clone()).unwrap();
    let task = restored.get_task("task-1").unwrap().unwrap();
    assert_eq!(task.status, AgentTaskStatus::Paused);
    assert_eq!(task.objective, "任务内容已脱敏");
    assert_eq!(task.actions[0].arguments, serde_json::Value::Null);
    let replayed = restored.events_since("task-1", 1).unwrap();
    assert_eq!(
        replayed
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    let sync = restored.sync_task("task-1", 1).unwrap();
    assert_eq!(sync.task.unwrap().id, "task-1");
    assert_eq!(sync.events.len(), 2);
    assert_eq!(
        restored.begin_model_turn(&task_context).unwrap_err(),
        "应用重启前的 AI 任务仅供查看，请发起新任务"
    );

    std::fs::remove_dir_all(directory).unwrap();
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
    assert_eq!(completed[2].task.diagnostics.model_turn_count, 1);
    assert_eq!(completed[2].task.diagnostics.action_count, 1);
    assert_eq!(completed[2].task.diagnostics.plan_step_count, 0);
    assert_eq!(completed[2].task.diagnostics.verification_evidence_count, 1);
    assert_eq!(completed[2].task.diagnostics.repair_attempt_count, 0);
    assert_eq!(completed[2].task.diagnostics.stop_reason, None);
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
fn terminal_commands_run_without_confirmation_in_full_access_mode() {
    let manager = AgentTaskManager::default();
    let mut full_access = context();
    full_access.approval_mode = AgentApprovalMode::FullAccess;
    manager.begin_model_turn(&full_access).unwrap();
    manager
        .register_actions("task-1", vec![terminal_command_intent()])
        .unwrap();
    manager.finish_model_turn("task-1", false).unwrap();

    let (action, events) = manager
        .authorize_action_execution("task-1", "command-1", false, false, None)
        .unwrap();
    assert_eq!(
        action.execution_kind,
        AgentActionExecutionKind::TerminalCommand
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, AgentTaskEventKind::ActionApproved);
    assert_eq!(
        events[0].task.actions[0].status,
        AgentActionStatus::Approved
    );
}

#[test]
fn auto_safe_approves_only_commands_assessed_as_low_risk() {
    let manager = AgentTaskManager::default();
    let mut auto_safe = context();
    auto_safe.approval_mode = AgentApprovalMode::AutoSafe;
    manager.begin_model_turn(&auto_safe).unwrap();
    manager
        .register_actions("task-1", vec![low_risk_terminal_command_intent()])
        .unwrap();
    manager.finish_model_turn("task-1", false).unwrap();
    assert!(manager
        .authorize_action_execution("task-1", "command-1", false, false, None)
        .is_ok());

    let manager = AgentTaskManager::default();
    manager.begin_model_turn(&context()).unwrap();
    manager
        .register_actions("task-1", vec![low_risk_terminal_command_intent()])
        .unwrap();
    manager.finish_model_turn("task-1", false).unwrap();
    assert_eq!(
        manager
            .authorize_action_execution("task-1", "command-1", false, false, None)
            .unwrap_err(),
        "该 AI 动作需要本次用户审批"
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
    assert_eq!(
        submitted[0].task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .phase,
        AgentCommandExecutionPhase::Connecting
    );
    let progress = manager
        .observe_command_progress(
            "task-1",
            "command-1",
            "submission-1",
            AgentCommandExecutionPhase::Running,
            AgentCommandOutputSnapshot {
                output_excerpt: Some("nginx is active".to_string()),
                stdout_excerpt: Some("nginx is active".to_string()),
                ..AgentCommandOutputSnapshot::default()
            },
        )
        .unwrap();
    assert_eq!(progress[0].kind, AgentTaskEventKind::ActionProgress);
    assert_eq!(
        progress[0].task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .output_excerpt
            .as_deref(),
        Some("nginx is active")
    );
    assert!(manager
        .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted,))
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
    let command = completed[1].task.actions[0]
        .command_execution
        .as_ref()
        .unwrap();
    assert_eq!(command.phase, AgentCommandExecutionPhase::Completed);
    assert_eq!(command.exit_code, Some(0));
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
fn command_progress_is_live_only_and_restart_marks_it_interrupted() {
    let directory = std::env::temp_dir().join(format!(
        "fineshell-agent-command-state-{}-{}",
        std::process::id(),
        super::timestamp_ms()
    ));
    let path = directory.join(AGENT_RUNTIME_STATE_FILE);
    let manager = AgentTaskManager::default();
    manager.initialize_storage(path.clone()).unwrap();
    manager.record_events(&manager.begin_model_turn(&context()).unwrap());
    manager.record_events(
        &manager
            .register_actions("task-1", vec![terminal_command_intent()])
            .unwrap(),
    );
    manager.record_events(&manager.finish_model_turn("task-1", false).unwrap());
    let (_, approved) = manager
        .authorize_action_execution("task-1", "command-1", false, true, None)
        .unwrap();
    manager.record_events(&approved);
    let submitted = manager
        .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
        .unwrap();
    manager.record_events(&submitted);
    let progress = manager
        .observe_command_progress(
            "task-1",
            "command-1",
            "submission-1",
            AgentCommandExecutionPhase::Running,
            AgentCommandOutputSnapshot {
                output_excerpt: Some("TOKEN=secret-runtime-output".to_string()),
                stdout_excerpt: Some("TOKEN=secret-runtime-output".to_string()),
                ..AgentCommandOutputSnapshot::default()
            },
        )
        .unwrap();
    manager.record_events(&progress);

    let live = manager.get_task("task-1").unwrap().unwrap();
    assert_eq!(
        live.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .output_excerpt
            .as_deref(),
        Some("TOKEN=secret-runtime-output")
    );
    let persisted = std::fs::read_to_string(&path).unwrap();
    assert!(!persisted.contains("secret-runtime-output"));
    assert!(!manager
        .events_since("task-1", submitted[0].sequence)
        .unwrap()
        .iter()
        .any(|event| event.kind == AgentTaskEventKind::ActionProgress));

    let restored = AgentTaskManager::default();
    restored.initialize_storage(path.clone()).unwrap();
    let task = restored.get_task("task-1").unwrap().unwrap();
    assert_eq!(task.status, AgentTaskStatus::Paused);
    assert_eq!(task.actions[0].status, AgentActionStatus::Cancelled);
    let command = task.actions[0].command_execution.as_ref().unwrap();
    assert_eq!(command.phase, AgentCommandExecutionPhase::Interrupted);
    assert!(command.output_excerpt.is_none());

    let (recovery, events) = restored
        .resolve_interruption(AgentTaskRecoveryRequest {
            task_id: "task-1".to_string(),
            decision: AgentTaskRecoveryDecision::ContinueAnalysis,
        })
        .unwrap();
    assert_eq!(
        recovery.interruption_reason,
        "应用重启后任务已中断，仅供查看，不会自动重新执行"
    );
    assert_eq!(events[0].task.status, AgentTaskStatus::Cancelled);
    assert_eq!(
        events[0]
            .task
            .result
            .as_ref()
            .and_then(|result| result.stop_reason.as_deref()),
        Some("interruption_continue")
    );

    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn cancelled_command_accepts_only_its_late_terminal_observation() {
    let manager = AgentTaskManager::default();
    manager.begin_model_turn(&context()).unwrap();
    manager
        .register_actions("task-1", vec![terminal_command_intent()])
        .unwrap();
    manager.finish_model_turn("task-1", false).unwrap();
    manager
        .authorize_action_execution("task-1", "command-1", false, true, None)
        .unwrap();
    manager
        .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
        .unwrap();

    let cancelled = manager.cancel_task("task-1").unwrap();
    assert_eq!(
        cancelled[0].task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .phase,
        AgentCommandExecutionPhase::Cancelling
    );
    let mut late = command_observation(AgentCommandObservationPhase::Unavailable);
    late.duration_ms = Some(25);
    late.reason = Some("AI 后台命令已取消".to_string());
    let events = manager.observe_command_execution(late).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, AgentTaskEventKind::ActionProgress);
    assert_eq!(events[0].task.status, AgentTaskStatus::Cancelled);
    assert_eq!(
        events[0].task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .phase,
        AgentCommandExecutionPhase::Interrupted
    );

    assert!(manager
        .observe_command_progress(
            "task-1",
            "command-1",
            "another-submission",
            AgentCommandExecutionPhase::Running,
            AgentCommandOutputSnapshot {
                output_excerpt: Some("stale".to_string()),
                stdout_excerpt: Some("stale".to_string()),
                ..AgentCommandOutputSnapshot::default()
            },
        )
        .unwrap()
        .is_empty());
}

#[test]
fn cancelled_command_restores_as_interrupted_before_late_observation() {
    let directory = std::env::temp_dir().join(format!(
        "fineshell-agent-cancelled-command-state-{}-{}",
        std::process::id(),
        super::timestamp_ms()
    ));
    let path = directory.join(AGENT_RUNTIME_STATE_FILE);
    let manager = AgentTaskManager::default();
    manager.initialize_storage(path.clone()).unwrap();
    manager.record_events(&manager.begin_model_turn(&context()).unwrap());
    manager.record_events(
        &manager
            .register_actions("task-1", vec![terminal_command_intent()])
            .unwrap(),
    );
    manager.record_events(&manager.finish_model_turn("task-1", false).unwrap());
    let (_, approved) = manager
        .authorize_action_execution("task-1", "command-1", false, true, None)
        .unwrap();
    manager.record_events(&approved);
    let submitted = manager
        .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
        .unwrap();
    manager.record_events(&submitted);
    let cancelled = manager.cancel_task("task-1").unwrap();
    manager.record_events(&cancelled);
    assert_eq!(
        cancelled[0].task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .phase,
        AgentCommandExecutionPhase::Cancelling
    );

    let restored = AgentTaskManager::default();
    restored.initialize_storage(path.clone()).unwrap();
    let task = restored.get_task("task-1").unwrap().unwrap();
    assert_eq!(task.status, AgentTaskStatus::Cancelled);
    let command = task.actions[0].command_execution.as_ref().unwrap();
    assert_eq!(command.phase, AgentCommandExecutionPhase::Interrupted);
    assert_eq!(command.reason.as_deref(), Some("应用重启导致后台命令中断"));

    std::fs::remove_dir_all(directory).unwrap();
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
fn task_context_rejects_unsupported_or_stale_snapshots() {
    let manager = AgentTaskManager::default();
    let mut unsupported = context();
    unsupported.context_version = super::AGENT_CONTEXT_VERSION + 1;
    assert_eq!(
        manager.begin_model_turn(&unsupported).unwrap_err(),
        "AI 任务上下文版本不受支持，请重新发起任务"
    );

    let mut stale = context();
    stale.context_captured_at =
        super::timestamp_ms().saturating_sub(super::MAX_AGENT_CONTEXT_AGE_MS + 1);
    assert_eq!(
        manager.begin_model_turn(&stale).unwrap_err(),
        "AI 任务上下文已过期，请重新发起任务"
    );
}

#[test]
fn model_turn_refreshes_execution_context_timestamp() {
    let manager = AgentTaskManager::default();
    let initial = context();
    manager.begin_model_turn(&initial).unwrap();
    let mut refreshed = initial.clone();
    refreshed.context_captured_at = refreshed.context_captured_at.saturating_add(1);
    manager.begin_model_turn(&refreshed).unwrap();
    manager
        .register_actions("task-1", vec![terminal_command_intent()])
        .unwrap();

    assert_eq!(
        manager
            .validate_action_execution_context("task-1", "command-1")
            .unwrap(),
        "session-1"
    );
    assert_eq!(
        manager
            .get_task("task-1")
            .unwrap()
            .unwrap()
            .context_captured_at,
        refreshed.context_captured_at
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
fn interrupted_task_recovery_is_consumed_once_and_requires_a_new_task() {
    let manager = AgentTaskManager::default();
    manager.begin_model_turn(&context()).unwrap();
    manager
        .register_actions("task-1", vec![terminal_command_intent()])
        .unwrap();
    manager
        .pause_disconnected("task-1", "SSH 连接已断开")
        .unwrap();

    let (recovery_context, events) = manager
        .resolve_interruption(AgentTaskRecoveryRequest {
            task_id: "task-1".to_string(),
            decision: AgentTaskRecoveryDecision::Retry,
        })
        .unwrap();
    assert_eq!(recovery_context.previous_task_id, "task-1");
    assert_eq!(recovery_context.host_id, "host-1");
    assert_eq!(recovery_context.uncertain_actions.len(), 1);
    assert_eq!(events[0].task.status, AgentTaskStatus::Cancelled);
    assert_eq!(
        events[0]
            .task
            .result
            .as_ref()
            .and_then(|result| result.stop_reason.as_deref()),
        Some("interruption_retry")
    );
    assert_eq!(
        manager
            .resolve_interruption(AgentTaskRecoveryRequest {
                task_id: "task-1".to_string(),
                decision: AgentTaskRecoveryDecision::Retry,
            })
            .unwrap_err(),
        "AI 任务当前不需要恢复决策"
    );

    let mut successor = context();
    successor.id = "task-2".to_string();
    let created = manager.begin_model_turn(&successor).unwrap();
    assert_eq!(created[0].task.id, "task-2");
    assert!(created[0].task.actions.is_empty());
}

#[test]
fn command_timeout_pauses_task_for_explicit_recovery() {
    let manager = AgentTaskManager::default();
    manager.begin_model_turn(&context()).unwrap();
    manager
        .register_actions("task-1", vec![terminal_command_intent()])
        .unwrap();
    manager.finish_model_turn("task-1", false).unwrap();
    manager
        .authorize_action_execution("task-1", "command-1", false, true, None)
        .unwrap();
    manager
        .observe_command_execution(command_observation(AgentCommandObservationPhase::Submitted))
        .unwrap();
    let mut timeout = command_observation(AgentCommandObservationPhase::Unavailable);
    timeout.reason = Some("AI 后台命令执行超时".to_string());
    timeout.duration_ms = Some(120_000);

    let events = manager.observe_command_execution(timeout).unwrap();
    let paused = events.last().unwrap();
    assert_eq!(paused.kind, AgentTaskEventKind::TaskPaused);
    assert_eq!(paused.task.status, AgentTaskStatus::Paused);
    assert_eq!(paused.task.error.as_deref(), Some("AI 后台命令执行超时"));
    assert_eq!(
        paused.task.actions[0]
            .command_execution
            .as_ref()
            .unwrap()
            .phase,
        AgentCommandExecutionPhase::Interrupted
    );
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
            feedback: None,
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
                feedback: None,
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
                feedback: None,
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
            feedback: None,
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
fn rejected_plan_preserves_bounded_user_feedback_for_the_agent() {
    let manager = AgentTaskManager::default();
    manager.begin_model_turn(&context()).unwrap();
    let (receiver, _) = manager
        .set_plan("task-1", network_plan(), network_approval_requirements())
        .unwrap();

    manager
        .decide_plan(AgentPlanDecisionRequest {
            task_id: "task-1".to_string(),
            plan_id: "plan-1".to_string(),
            decision: AgentPlanDecisionKind::Reject,
            feedback: Some("  不要访问公网，只读取本机连接  ".to_string()),
            selected_call_ids: Vec::new(),
        })
        .unwrap();

    assert_eq!(
        receiver.borrow().clone(),
        AgentPlanDecision::Reject(Some("不要访问公网，只读取本机连接".to_string()))
    );
}

#[test]
fn serialized_enums_match_the_shared_contract() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../protocol/contract.json")).unwrap();
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
            AgentTaskEventKind::ActionProgress,
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
            AgentCommandExecutionPhase::Connecting,
            AgentCommandExecutionPhase::Running,
            AgentCommandExecutionPhase::Cancelling,
            AgentCommandExecutionPhase::Completed,
            AgentCommandExecutionPhase::Failed,
            AgentCommandExecutionPhase::Interrupted,
        ]),
        contract_keys("agentCommandExecutionPhases")
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
            AgentActionRisk::LowRisk,
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
