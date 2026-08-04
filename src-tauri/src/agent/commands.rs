use super::*;

pub(crate) fn emit_task_events(app: &AppHandle, events: Vec<AgentTaskEvent>) {
    if let Some(manager) = app.try_state::<AgentTaskManager>() {
        manager.record_events(&events);
    }
    for event in events {
        let _ = app.emit_to("main", AGENT_TASK_EVENT, event);
    }
}

#[tauri::command]
pub(crate) fn ai_task_events_since(
    manager: State<'_, AgentTaskManager>,
    task_id: String,
    after_sequence: u64,
) -> CommandResult<Vec<AgentTaskEvent>> {
    let operation = "ai_task_events_since";
    if !valid_identifier(&task_id) {
        return Err(CommandError::from_message(operation, "AI 任务标识无效"));
    }
    manager
        .events_since(&task_id, after_sequence)
        .map_err(|error| CommandError::from_message(operation, error))
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
