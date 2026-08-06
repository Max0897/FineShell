use super::*;

struct AgentScenario {
    manager: AgentTaskManager,
}

impl AgentScenario {
    fn persisted(path: std::path::PathBuf) -> Self {
        let manager = AgentTaskManager::default();
        manager.initialize_storage(path).unwrap();
        Self { manager }
    }

    fn record(&self, events: Vec<AgentTaskEvent>) -> Vec<AgentTaskEvent> {
        self.manager.record_events(&events);
        events
    }

    fn context(task_id: &str) -> AgentTaskContext {
        AgentTaskContext {
            context_version: AGENT_CONTEXT_VERSION,
            context_captured_at: timestamp_ms(),
            id: task_id.to_string(),
            conversation_id: "conversation-scenario".to_string(),
            host_id: "host-scenario".to_string(),
            terminal_session_id: Some("session-scenario".to_string()),
            current_directory: Some("/srv/app".to_string()),
            file_operation_directory: Some("/srv/app".to_string()),
            writable_files: Vec::new(),
            objective: "检查并恢复 Nginx 服务".to_string(),
            approval_mode: AgentApprovalMode::OnRequest,
        }
    }

    fn command_intent() -> AgentActionIntent {
        AgentActionIntent {
            id: "command-scenario".to_string(),
            tool: "execute_terminal_command".to_string(),
            arguments: serde_json::json!({
                "command": "systemctl status nginx",
                "purpose": "检查 Nginx 状态",
            }),
            reason: "需要确认服务状态".to_string(),
            expected_effect: "读取 Nginx 服务状态".to_string(),
            risk: AgentActionRisk::LowRisk,
        }
    }

    fn command_observation(
        task_id: &str,
        phase: AgentCommandObservationPhase,
    ) -> AgentCommandObservationRequest {
        AgentCommandObservationRequest {
            task_id: task_id.to_string(),
            action_id: "command-scenario".to_string(),
            host_id: "host-scenario".to_string(),
            session_id: "session-scenario".to_string(),
            submission_id: "submission-scenario".to_string(),
            phase,
            command: "systemctl status nginx".to_string(),
            exit_code: None,
            duration_ms: None,
            reason: None,
        }
    }
}

#[test]
fn approved_command_completes_and_restores_the_full_agent_timeline() {
    let directory = std::env::temp_dir().join(format!(
        "fineshell-agent-scenario-{}-{}",
        std::process::id(),
        timestamp_ms()
    ));
    let storage_path = directory.join(AGENT_RUNTIME_STATE_FILE);
    let scenario = AgentScenario::persisted(storage_path.clone());
    let context = AgentScenario::context("scenario-approved");

    scenario.record(scenario.manager.begin_model_turn(&context).unwrap());
    scenario.record(
        scenario
            .manager
            .register_actions(&context.id, vec![AgentScenario::command_intent()])
            .unwrap(),
    );
    scenario.record(
        scenario
            .manager
            .finish_model_turn(&context.id, false)
            .unwrap(),
    );
    let (execution, approved) = scenario
        .manager
        .authorize_action_execution(&context.id, "command-scenario", false, true, None)
        .unwrap();
    assert_eq!(execution.session_id, "session-scenario");
    scenario.record(approved);
    scenario.record(
        scenario
            .manager
            .observe_command_execution(AgentScenario::command_observation(
                &context.id,
                AgentCommandObservationPhase::Submitted,
            ))
            .unwrap(),
    );
    scenario.record(
        scenario
            .manager
            .observe_command_progress(
                &context.id,
                "command-scenario",
                "submission-scenario",
                AgentCommandExecutionPhase::Running,
                AgentCommandOutputSnapshot {
                    output_excerpt: Some("Active: active (running)".to_string()),
                    stdout_excerpt: Some("Active: active (running)".to_string()),
                    ..AgentCommandOutputSnapshot::default()
                },
            )
            .unwrap(),
    );
    let mut completed =
        AgentScenario::command_observation(&context.id, AgentCommandObservationPhase::Completed);
    completed.exit_code = Some(0);
    completed.duration_ms = Some(420);
    scenario.record(
        scenario
            .manager
            .observe_command_execution(completed)
            .unwrap(),
    );

    let task = scenario.manager.get_task(&context.id).unwrap().unwrap();
    assert_eq!(task.status, AgentTaskStatus::Completed);
    assert_eq!(task.actions[0].status, AgentActionStatus::Succeeded);
    assert_eq!(task.actions[0].duration_ms, Some(420));
    assert_eq!(task.diagnostics.model_turn_count, 1);
    assert_eq!(task.diagnostics.action_count, 1);
    assert_eq!(task.diagnostics.verification_evidence_count, 1);

    let kinds = scenario
        .manager
        .events_since(&context.id, 0)
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            AgentTaskEventKind::TaskCreated,
            AgentTaskEventKind::ModelTurnStarted,
            AgentTaskEventKind::ActionProposed,
            AgentTaskEventKind::ModelTurnCompleted,
            AgentTaskEventKind::ActionApproved,
            AgentTaskEventKind::ActionStarted,
            AgentTaskEventKind::ActionSucceeded,
            AgentTaskEventKind::ActionVerificationRecorded,
            AgentTaskEventKind::TaskCompleted,
        ]
    );

    let restored = AgentTaskManager::default();
    restored.initialize_storage(storage_path).unwrap();
    let restored_task = restored.get_task(&context.id).unwrap().unwrap();
    assert_eq!(restored_task.status, AgentTaskStatus::Completed);
    assert_eq!(
        restored_task.actions[0].status,
        AgentActionStatus::Succeeded
    );
    assert_eq!(
        restored
            .events_since(&context.id, 0)
            .unwrap()
            .last()
            .unwrap()
            .kind,
        AgentTaskEventKind::TaskCompleted
    );

    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn disconnected_action_is_closed_before_a_fresh_recovery_task_runs() {
    let manager = AgentTaskManager::default();
    let context = AgentScenario::context("scenario-disconnected");
    manager.begin_model_turn(&context).unwrap();
    manager
        .register_actions(&context.id, vec![AgentScenario::command_intent()])
        .unwrap();
    manager.finish_model_turn(&context.id, false).unwrap();

    let paused = manager
        .pause_disconnected(&context.id, "SSH 连接已断开")
        .unwrap();
    assert_eq!(paused[0].task.status, AgentTaskStatus::PausedDisconnected);
    let (recovery, closed) = manager
        .resolve_interruption(AgentTaskRecoveryRequest {
            task_id: context.id.clone(),
            decision: AgentTaskRecoveryDecision::Retry,
        })
        .unwrap();
    assert_eq!(recovery.uncertain_actions.len(), 1);
    assert_eq!(closed[0].task.status, AgentTaskStatus::Cancelled);
    assert_eq!(
        closed[0].task.actions[0].status,
        AgentActionStatus::Cancelled
    );

    let fresh_context = AgentScenario::context("scenario-retry");
    manager.begin_model_turn(&fresh_context).unwrap();
    let completed = manager.finish_model_turn(&fresh_context.id, false).unwrap();
    assert_eq!(completed[0].kind, AgentTaskEventKind::TaskCompleted);
    assert!(completed[0].task.actions.is_empty());
    assert_eq!(
        manager
            .authorize_action_execution(&context.id, "command-scenario", false, true, None,)
            .unwrap_err(),
        "AI 任务已经结束"
    );
}

#[test]
fn stale_context_is_rejected_before_a_read_only_agent_task_can_start() {
    let manager = AgentTaskManager::default();
    let mut stale = AgentScenario::context("scenario-read-only");
    stale.context_captured_at = timestamp_ms().saturating_sub(MAX_AGENT_CONTEXT_AGE_MS + 1);
    assert_eq!(
        manager.begin_model_turn(&stale).unwrap_err(),
        "AI 任务上下文已过期，请重新发起任务"
    );
    assert!(manager.get_task(&stale.id).unwrap().is_none());

    let fresh = AgentScenario::context("scenario-read-only");
    let started = manager.begin_model_turn(&fresh).unwrap();
    assert_eq!(started[0].kind, AgentTaskEventKind::TaskCreated);
    let completed = manager.finish_model_turn(&fresh.id, false).unwrap();
    assert_eq!(completed[0].task.status, AgentTaskStatus::Completed);
    assert_eq!(completed[0].task.actions.len(), 0);
    assert_eq!(
        completed[0]
            .task
            .result
            .as_ref()
            .unwrap()
            .verification_status,
        AgentVerificationStatus::NotApplicable
    );
}
