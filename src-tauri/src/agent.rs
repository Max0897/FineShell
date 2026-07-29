use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

use crate::protocol::{CommandError, CommandResult, AGENT_TASK_EVENT, PROTOCOL_VERSION};

const MAX_AGENT_TASKS: usize = 100;
const MAX_AGENT_ID_CHARS: usize = 160;
const MAX_AGENT_OBJECTIVE_CHARS: usize = 24_000;

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionIntent {
    id: String,
    tool: String,
    arguments: serde_json::Value,
    reason: String,
    expected_effect: String,
    risk: AgentActionRisk,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskResult {
    summary: String,
    verified: bool,
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
    approval_mode: AgentApprovalMode,
    status: AgentTaskStatus,
    objective: String,
    plan: Option<AgentPlan>,
    active_step_id: Option<String>,
    pending_action: Option<AgentActionIntent>,
    iteration: u32,
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
    task: AgentTask,
}

#[derive(Default)]
pub(crate) struct AgentTaskManager {
    tasks: Mutex<HashMap<String, AgentTask>>,
    plan_controls: Mutex<HashMap<String, AgentPlanControl>>,
}

struct AgentPlanControl {
    plan_id: String,
    sender: watch::Sender<AgentPlanDecision>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AgentPlanDecision {
    Pending,
    Approve(Vec<String>),
    Reject,
    Stop,
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

impl AgentTaskContext {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn terminal_session_id(&self) -> Option<&str> {
        self.terminal_session_id.as_deref()
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
        {
            return Err("AI 任务作用域无效".to_string());
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
            approval_mode: context.approval_mode,
            status: AgentTaskStatus::Understanding,
            objective: context.objective.trim().to_string(),
            plan: None,
            active_step_id: None,
            pending_action: None,
            iteration: 0,
            last_event_sequence: 0,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn event(&mut self, kind: AgentTaskEventKind) -> AgentTaskEvent {
        self.last_event_sequence = self.last_event_sequence.saturating_add(1);
        self.updated_at = timestamp_ms();
        AgentTaskEvent {
            protocol_version: PROTOCOL_VERSION,
            sequence: self.last_event_sequence,
            kind,
            task: self.clone(),
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
        if has_tool_calls {
            task.status = AgentTaskStatus::Running;
            Ok(vec![task.event(AgentTaskEventKind::ModelTurnCompleted)])
        } else {
            task.status = AgentTaskStatus::Completed;
            task.result = Some(AgentTaskResult {
                summary: "AI 任务已完成".to_string(),
                verified: false,
                stop_reason: None,
            });
            Ok(vec![task.event(AgentTaskEventKind::TaskCompleted)])
        }
    }

    pub(crate) fn set_plan(
        &self,
        task_id: &str,
        mut plan: AgentPlan,
        awaiting_approval: bool,
    ) -> Result<(watch::Receiver<AgentPlanDecision>, Vec<AgentTaskEvent>), String> {
        let initial_decision = if awaiting_approval {
            AgentPlanDecision::Pending
        } else {
            AgentPlanDecision::Approve(plan.steps.iter().map(|step| step.id.clone()).collect())
        };
        plan.status = AgentPlanStatus::Pending;
        let (sender, receiver) = watch::channel(initial_decision);
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
        if let Ok(mut controls) = self.plan_controls.lock() {
            controls.remove(task_id);
        }
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
        {
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
        }
        let controls = self
            .plan_controls
            .lock()
            .map_err(|_| "AI 计划控制状态不可用".to_string())?;
        let control = controls
            .get(&request.task_id)
            .filter(|control| control.plan_id == request.plan_id)
            .ok_or_else(|| "AI 计划已经结束".to_string())?;
        let decision = match request.decision {
            AgentPlanDecisionKind::Approve => AgentPlanDecision::Approve(selected_call_ids),
            AgentPlanDecisionKind::Reject => AgentPlanDecision::Reject,
            AgentPlanDecisionKind::Stop => AgentPlanDecision::Stop,
        };
        control
            .sender
            .send(decision)
            .map_err(|_| "AI 计划已经结束".to_string())
    }

    pub(crate) fn fail_task(
        &self,
        task_id: &str,
        message: &str,
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
        task.status = AgentTaskStatus::Failed;
        task.active_step_id = None;
        task.error = Some(message.chars().take(500).collect());
        Ok(vec![task.event(AgentTaskEventKind::TaskFailed)])
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
            task.result = Some(AgentTaskResult {
                summary: "AI 任务已取消".to_string(),
                verified: false,
                stop_reason: Some("user_cancelled".to_string()),
            });
            vec![task.event(AgentTaskEventKind::TaskCancelled)]
        };
        if let Ok(controls) = self.plan_controls.lock() {
            if let Some(control) = controls.get(task_id) {
                let _ = control.sender.send(AgentPlanDecision::Stop);
            }
        }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{
        AgentActionRisk, AgentApprovalMode, AgentPlan, AgentPlanDecision, AgentPlanDecisionKind,
        AgentPlanDecisionRequest, AgentPlanStatus, AgentPlanStep, AgentPlanStepStatus,
        AgentTaskContext, AgentTaskEventKind, AgentTaskManager, AgentTaskStatus,
    };

    fn context() -> AgentTaskContext {
        AgentTaskContext {
            id: "task-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            host_id: "host-1".to_string(),
            terminal_session_id: Some("session-1".to_string()),
            current_directory: Some("/srv/app".to_string()),
            objective: "检查服务器状态".to_string(),
            approval_mode: AgentApprovalMode::OnRequest,
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
    fn plan_decisions_are_scoped_to_the_active_task_and_plan() {
        let manager = AgentTaskManager::default();
        manager.begin_model_turn(&context()).unwrap();
        let plan = AgentPlan {
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
        };
        let (receiver, events) = manager.set_plan("task-1", plan, true).unwrap();
        assert_eq!(events[0].kind, AgentTaskEventKind::PlanCreated);
        manager
            .decide_plan(AgentPlanDecisionRequest {
                task_id: "task-1".to_string(),
                plan_id: "plan-1".to_string(),
                decision: AgentPlanDecisionKind::Approve,
                selected_call_ids: vec!["call-1".to_string()],
            })
            .unwrap();
        assert_eq!(
            *receiver.borrow(),
            AgentPlanDecision::Approve(vec!["call-1".to_string()])
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
    }
}
