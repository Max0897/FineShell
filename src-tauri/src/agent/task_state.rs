use super::*;

impl AgentTaskManager {
    pub(crate) fn resolve_interruption(
        &self,
        request: AgentTaskRecoveryRequest,
    ) -> Result<(AgentTaskRecoveryContext, Vec<AgentTaskEvent>), String> {
        let context = {
            let tasks = self.lock_tasks()?;
            let task = tasks
                .get(&request.task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if !matches!(
                task.status,
                AgentTaskStatus::Paused | AgentTaskStatus::PausedDisconnected
            ) {
                return Err("AI 任务当前不需要恢复决策".to_string());
            }
            let summarize = |action: &AgentActionState| {
                action
                    .summary
                    .as_deref()
                    .or(action.error.as_deref())
                    .unwrap_or(action.reason.as_str())
                    .chars()
                    .take(160)
                    .collect::<String>()
            };
            AgentTaskRecoveryContext {
                previous_task_id: task.id.clone(),
                host_id: task.host_id.clone(),
                decision: request.decision,
                objective: task.objective.clone(),
                interruption_reason: task
                    .error
                    .clone()
                    .unwrap_or_else(|| "AI 任务执行被中断".to_string()),
                completed_actions: task
                    .actions
                    .iter()
                    .filter(|action| action.status == AgentActionStatus::Succeeded)
                    .map(summarize)
                    .collect(),
                uncertain_actions: task
                    .actions
                    .iter()
                    .filter(|action| action.status != AgentActionStatus::Succeeded)
                    .map(summarize)
                    .collect(),
            }
        };
        let (summary, stop_reason, action_message) = match request.decision {
            AgentTaskRecoveryDecision::ContinueAnalysis => (
                "已从中断点创建后继分析任务",
                "interruption_continue",
                "旧任务已结束，后继任务将重新确认当前状态",
            ),
            AgentTaskRecoveryDecision::Retry => (
                "已从中断点创建全新重试任务",
                "interruption_retry",
                "旧任务已结束，重试动作必须重新审批",
            ),
            AgentTaskRecoveryDecision::Finish => (
                "用户结束了中断任务",
                "interruption_finished",
                "用户结束了中断任务",
            ),
        };
        let events = self.close_task(&request.task_id, summary, stop_reason, action_message)?;
        Ok((context, events))
    }

    pub(crate) fn fail_task(
        &self,
        task_id: &str,
        message: &str,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self.lock_tasks()?;
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
            let mut tasks = self.lock_tasks()?;
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
        let mut tasks = self.lock_tasks()?;
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
        self.close_task(
            task_id,
            "AI 任务已取消",
            "user_cancelled",
            "用户取消了 AI 任务",
        )
    }

    fn close_task(
        &self,
        task_id: &str,
        summary: &str,
        stop_reason: &str,
        action_message: &str,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = {
            let mut tasks = self.lock_tasks()?;
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
                    if let Some(command) = action.command_execution.as_mut() {
                        command.phase = AgentCommandExecutionPhase::Cancelling;
                        command.reason = Some(action_message.to_string());
                        command.updated_at = now;
                    }
                    action.status = AgentActionStatus::Cancelled;
                    action.error = Some(action_message.to_string());
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
                        step.summary = Some(action_message.to_string());
                        step.error = Some(action_message.to_string());
                    }
                }
            }
            task.result = Some(AgentTaskResult {
                summary: summary.to_string(),
                verified: false,
                verification_status: AgentVerificationStatus::NotApplicable,
                stop_reason: Some(stop_reason.to_string()),
            });
            task.error = None;
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

    pub(super) fn get_task(&self, task_id: &str) -> Result<Option<AgentTask>, String> {
        let tasks = self.lock_tasks()?;
        Ok(tasks.get(task_id).cloned())
    }
}
