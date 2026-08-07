use super::*;

impl Default for AgentTaskManager {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            events: Mutex::new(HashMap::new()),
            storage_path: Mutex::new(None),
            plan_controls: Mutex::new(HashMap::new()),
            approval_credentials: Mutex::new(ApprovalCredentialStore::default()),
        }
    }
}

impl AgentTaskManager {
    pub(super) fn initialize_storage(&self, path: PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 AI 运行时目录：{error}"))?;
        }
        let restored = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<PersistedAgentRuntime>(&bytes) {
                Ok(state) if state.version == AGENT_RUNTIME_STATE_VERSION => Some(state),
                Ok(_) => {
                    log::warn!(target: "fineshell::agent", "忽略不兼容的 AI 运行时状态文件");
                    None
                }
                Err(error) => {
                    log::warn!(target: "fineshell::agent", "忽略损坏的 AI 运行时状态文件: {error}");
                    None
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法读取 AI 运行时状态：{error}")),
        };

        *self
            .storage_path
            .lock()
            .map_err(|_| "AI 运行时存储状态不可用".to_string())? = Some(path);
        let Some(restored) = restored else {
            return Ok(());
        };

        let mut tasks = HashMap::new();
        for mut task in restored.tasks.into_iter().take(MAX_AGENT_TASKS) {
            if !valid_identifier(&task.id) {
                continue;
            }
            task = task.redacted_for_persistence();
            let interrupted_at = timestamp_ms();
            let task_was_running = !task.status.is_terminal();
            let mut restored_interruption = false;
            for action in &mut task.actions {
                if task_was_running && action.status.is_unresolved() {
                    action.status = AgentActionStatus::Cancelled;
                    action.summary = None;
                    action.error = Some("应用重启时动作仍在执行，已标记为中断".to_string());
                    action.completed_at = Some(interrupted_at);
                    action.duration_ms = action
                        .started_at
                        .map(|started_at| interrupted_at.saturating_sub(started_at));
                    action.verification_status = AgentVerificationStatus::NotApplicable;
                    restored_interruption = true;
                }
                if let Some(command) = action.command_execution.as_mut() {
                    if !command.phase.is_terminal() {
                        command.phase = AgentCommandExecutionPhase::Interrupted;
                        command.reason = Some("应用重启导致后台命令中断".to_string());
                        command.updated_at = interrupted_at;
                        command.completed_at = Some(interrupted_at);
                        restored_interruption = true;
                    }
                }
            }
            if task_was_running {
                task.status = AgentTaskStatus::Paused;
                task.active_step_id = None;
                task.error = Some("应用重启后任务已中断，仅供查看，不会自动重新执行".to_string());
            }
            if restored_interruption {
                task.updated_at = interrupted_at;
                task.refresh_diagnostics();
            }
            tasks.insert(task.id.clone(), task);
        }
        *self.lock_tasks()? = tasks;

        let known_task_ids = self.lock_tasks()?.keys().cloned().collect::<Vec<_>>();

        let mut events_by_task: HashMap<String, VecDeque<AgentTaskEvent>> = HashMap::new();
        for mut event in restored.events {
            if !valid_identifier(&event.task.id) || !known_task_ids.contains(&event.task.id) {
                continue;
            }
            event.protocol_version = PROTOCOL_VERSION;
            event.task = event.task.redacted_for_persistence();
            let queue = events_by_task.entry(event.task.id.clone()).or_default();
            queue.push_back(event);
            while queue.len() > MAX_AGENT_EVENTS_PER_TASK {
                queue.pop_front();
            }
        }
        *self
            .events
            .lock()
            .map_err(|_| "AI 事件状态不可用".to_string())? = events_by_task;
        Ok(())
    }

    pub(super) fn record_events(&self, events: &[AgentTaskEvent]) {
        if events.is_empty() {
            return;
        }
        let Ok(mut stored) = self.events.lock() else {
            return;
        };
        let mut recorded = false;
        for event in events {
            if event.kind == AgentTaskEventKind::ActionProgress {
                continue;
            }
            recorded = true;
            let mut event = event.clone();
            event.task = event.task.redacted_for_persistence();
            let queue = stored.entry(event.task.id.clone()).or_default();
            queue.push_back(event);
            while queue.len() > MAX_AGENT_EVENTS_PER_TASK {
                queue.pop_front();
            }
        }
        drop(stored);
        if !recorded {
            return;
        }
        if let Err(error) = self.persist_state() {
            log::warn!(target: "fineshell::agent", "保存 AI 运行时状态失败: {error}");
        }
    }

    pub(super) fn persist_state(&self) -> Result<(), String> {
        let Some(path) = self
            .storage_path
            .lock()
            .map_err(|_| "AI 运行时存储状态不可用".to_string())?
            .clone()
        else {
            return Ok(());
        };
        let mut tasks = self
            .lock_tasks()?
            .values()
            .map(AgentTask::redacted_for_persistence)
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.updated_at);
        let mut events = self
            .events
            .lock()
            .map_err(|_| "AI 事件状态不可用".to_string())?
            .values()
            .flat_map(|events| events.iter().cloned())
            .collect::<Vec<_>>();
        events.sort_by_key(|event| (event.task.updated_at, event.sequence));
        let bytes = serde_json::to_vec(&PersistedAgentRuntime {
            version: AGENT_RUNTIME_STATE_VERSION,
            tasks,
            events,
        })
        .map_err(|error| format!("无法序列化 AI 运行时状态：{error}"))?;
        fs::write(path, bytes).map_err(|error| format!("无法写入 AI 运行时状态：{error}"))
    }

    pub(super) fn events_since(
        &self,
        task_id: &str,
        after_sequence: u64,
    ) -> Result<Vec<AgentTaskEvent>, String> {
        let events = self
            .events
            .lock()
            .map_err(|_| "AI 事件状态不可用".to_string())?;
        Ok(events
            .get(task_id)
            .into_iter()
            .flatten()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect())
    }

    pub(super) fn sync_task(
        &self,
        task_id: &str,
        after_sequence: u64,
    ) -> Result<AgentTaskSync, String> {
        let task = self.get_task(task_id)?;
        let events = self.events_since(task_id, after_sequence)?;
        Ok(AgentTaskSync { task, events })
    }
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位 AI 运行时目录：{error}"))?
        .join(AGENT_RUNTIME_STATE_FILE);
    app.state::<AgentTaskManager>().initialize_storage(path)
}
