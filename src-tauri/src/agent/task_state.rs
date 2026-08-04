use super::*;

impl AgentTaskManager {
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

    pub(super) fn get_task(&self, task_id: &str) -> Result<Option<AgentTask>, String> {
        let tasks = self.lock_tasks()?;
        Ok(tasks.get(task_id).cloned())
    }
}
