use super::*;

impl AgentTaskManager {
    pub(crate) fn begin_model_turn(
        &self,
        context: &AgentTaskContext,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        context.validate()?;
        let mut tasks = self.lock_tasks()?;
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
        if task.status == AgentTaskStatus::Paused {
            return Err("应用重启前的 AI 任务仅供查看，请发起新任务".to_string());
        }
        if !context.matches(task) {
            return Err("AI 任务作用域与已有任务不一致".to_string());
        }
        if task.status.is_terminal() {
            return Err("AI 任务已经结束".to_string());
        }
        task.refresh_context(context);
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
            let mut tasks = self.lock_tasks()?;
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
        let mut tasks = self.lock_tasks()?;
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
}
