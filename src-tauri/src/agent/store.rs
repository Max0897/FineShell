use super::*;

impl AgentTaskManager {
    pub(super) fn lock_tasks(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, AgentTask>>, String> {
        self.tasks
            .lock()
            .map_err(|_| "AI 任务状态不可用".to_string())
    }
}
