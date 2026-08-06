use super::*;

#[derive(Clone, Default)]
pub(crate) struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    auth_configs: Arc<Mutex<HashMap<String, SshAuthConfig>>>,
    agent_sessions: Arc<Mutex<HashMap<String, Sender<AgentSessionCommand>>>>,
    agent_executions: Arc<Mutex<HashMap<String, AgentExecutionControl>>>,
}

#[derive(Clone)]
struct AgentExecutionControl {
    session_id: String,
    cancelled: Arc<AtomicBool>,
}

impl SshSessionManager {
    pub(crate) fn is_connected(&self, session_id: &str) -> Result<bool, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?;
        Ok(matches!(
            sessions.get(session_id),
            Some(SessionHandle::Connected(_))
        ))
    }

    pub(crate) fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        self.send(session_id, SessionCommand::Write(data))
    }

    pub(super) fn begin_connect(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?;
        if sessions.contains_key(session_id) {
            return Err("该终端会话已存在".to_string());
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        sessions.insert(
            session_id.to_string(),
            SessionHandle::Connecting(cancelled.clone()),
        );
        Ok(cancelled)
    }

    pub(super) fn activate(
        &self,
        session_id: &str,
        sender: Sender<SessionCommand>,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?;
        match sessions.get(session_id) {
            Some(SessionHandle::Connecting(cancelled)) if !cancelled.load(Ordering::Acquire) => {
                sessions.insert(session_id.to_string(), SessionHandle::Connected(sender));
                Ok(())
            }
            _ => Err("SSH 连接已取消".to_string()),
        }
    }

    pub(super) fn register_auth_config(
        &self,
        session_id: &str,
        auth_config: SshAuthConfig,
    ) -> Result<(), String> {
        if !self.is_connected(session_id)? {
            return Err("SSH 会话尚未连接".to_string());
        }
        self.auth_configs
            .lock()
            .map_err(|_| "SSH 认证配置状态不可用".to_string())?
            .insert(session_id.to_string(), auth_config);
        Ok(())
    }

    pub(super) fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?;
        match handle {
            SessionHandle::Connected(sender) => sender.send(command).map_err(|_| {
                self.remove(session_id);
                "SSH 会话已停止".to_string()
            }),
            SessionHandle::Connecting(_) => Err("SSH 会话仍在连接".to_string()),
        }
    }

    pub(super) fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?
            .remove(session_id)
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?;
        self.remove_agent_session(session_id);
        match handle {
            SessionHandle::Connecting(cancelled) => {
                cancelled.store(true, Ordering::Release);
                Ok(())
            }
            SessionHandle::Connected(sender) => sender
                .send(SessionCommand::Close)
                .map_err(|_| "SSH 会话已停止".to_string()),
        }
    }

    pub(super) fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        self.remove_agent_session(session_id);
    }

    fn remove_agent_session(&self, session_id: &str) {
        if let Ok(mut configs) = self.auth_configs.lock() {
            configs.remove(session_id);
        }
        if let Ok(mut sessions) = self.agent_sessions.lock() {
            if let Some(sender) = sessions.remove(session_id) {
                let _ = sender.send(AgentSessionCommand::Close);
            }
        }
        if let Ok(executions) = self.agent_executions.lock() {
            for execution in executions.values() {
                if execution.session_id == session_id {
                    execution.cancelled.store(true, Ordering::Release);
                }
            }
        }
    }

    fn agent_session_sender(
        &self,
        session_id: &str,
    ) -> Result<Sender<AgentSessionCommand>, String> {
        if let Some(sender) = self
            .agent_sessions
            .lock()
            .map_err(|_| "AI 后台 SSH 会话状态不可用".to_string())?
            .get(session_id)
            .cloned()
        {
            return Ok(sender);
        }
        let config = self
            .auth_configs
            .lock()
            .map_err(|_| "SSH 认证配置状态不可用".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "终端会话已断开，无法创建 AI 后台 SSH 连接".to_string())?;
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name(format!("ssh-agent-{session_id}"))
            .spawn(move || run_agent_session(config, receiver))
            .map_err(|error| format!("无法启动 AI 后台 SSH 线程：{error}"))?;
        self.agent_sessions
            .lock()
            .map_err(|_| "AI 后台 SSH 会话状态不可用".to_string())?
            .insert(session_id.to_string(), sender.clone());
        Ok(sender)
    }

    pub(crate) async fn execute_agent_command(
        &self,
        app: AppHandle,
        context: AgentCommandExecutionContext,
        session_id: &str,
        command: String,
        current_directory: Option<String>,
    ) -> Result<AgentCommandExecutionResult, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut executions = self
                .agent_executions
                .lock()
                .map_err(|_| "AI 后台命令状态不可用".to_string())?;
            if executions.contains_key(&context.task_id) {
                return Err("该 AI 任务已有后台命令正在执行".to_string());
            }
            executions.insert(
                context.task_id.clone(),
                AgentExecutionControl {
                    session_id: session_id.to_string(),
                    cancelled: cancelled.clone(),
                },
            );
        }
        let sender = match self.agent_session_sender(session_id) {
            Ok(sender) => sender,
            Err(error) => {
                if let Ok(mut executions) = self.agent_executions.lock() {
                    executions.remove(&context.task_id);
                }
                return Err(error);
            }
        };
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        if sender
            .send(AgentSessionCommand::Execute(Box::new(
                AgentCommandRequest {
                    app,
                    context: context.clone(),
                    command,
                    current_directory,
                    cancelled: cancelled.clone(),
                    response: response_sender,
                },
            )))
            .is_err()
        {
            if let Ok(mut executions) = self.agent_executions.lock() {
                executions.remove(&context.task_id);
            }
            self.remove_agent_session(session_id);
            return Err("AI 后台 SSH 会话已停止".to_string());
        }
        let wait_result = tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(AGENT_COMMAND_TIMEOUT + Duration::from_secs(10))
                .map_err(|error| format!("等待 AI 后台命令结果失败：{error}"))?
        })
        .await;
        if wait_result.is_err() || wait_result.as_ref().is_ok_and(Result::is_err) {
            cancelled.store(true, Ordering::Release);
        }
        if let Ok(mut executions) = self.agent_executions.lock() {
            if executions
                .get(&context.task_id)
                .is_some_and(|control| Arc::ptr_eq(&control.cancelled, &cancelled))
            {
                executions.remove(&context.task_id);
            }
        }
        wait_result.map_err(|error| format!("AI 后台命令任务异常结束：{error}"))?
    }

    pub(crate) fn cancel_agent_commands(&self, task_id: &str) {
        if let Ok(executions) = self.agent_executions.lock() {
            if let Some(execution) = executions.get(task_id) {
                execution.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) async fn monitor_snapshot(
        &self,
        session_id: &str,
    ) -> Result<ServerMonitorSnapshot, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(session_id, SessionCommand::Monitor(response_sender))?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(15))
                .map_err(|error| format!("等待服务器监控数据失败：{error}"))?
        })
        .await
        .map_err(|error| format!("服务器监控任务异常结束：{error}"))?
    }

    pub(crate) async fn ping(
        &self,
        session_id: &str,
        target: String,
    ) -> Result<NetworkPingResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::Ping {
                target,
                response: response_sender,
            },
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| format!("等待 Ping 结果失败：{error}"))?
        })
        .await
        .map_err(|error| format!("Ping 任务异常结束：{error}"))?
    }

    pub(crate) async fn network_connections(
        &self,
        session_id: &str,
    ) -> Result<NetworkConnectionsResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::NetworkConnections(response_sender),
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| format!("等待网络连接数据失败：{error}"))?
        })
        .await
        .map_err(|error| format!("网络连接采集任务异常结束：{error}"))?
    }

    pub(crate) async fn trace_route(
        &self,
        session_id: &str,
        target: String,
    ) -> Result<NetworkTraceResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::TraceRoute {
                target,
                response: response_sender,
            },
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(20))
                .map_err(|error| format!("等待路由追踪结果失败：{error}"))?
        })
        .await
        .map_err(|error| format!("路由追踪任务异常结束：{error}"))?
    }

    pub(crate) async fn processes(
        &self,
        session_id: &str,
    ) -> Result<ServerProcessListResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(session_id, SessionCommand::Processes(response_sender))?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| format!("等待进程列表失败：{error}"))?
        })
        .await
        .map_err(|error| format!("进程采集任务异常结束：{error}"))?
    }

    pub(crate) async fn inspect_service(
        &self,
        session_id: &str,
        service: String,
    ) -> Result<crate::monitor::ServiceInspectionResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::InspectService {
                service,
                response: response_sender,
            },
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| format!("等待服务状态失败：{error}"))?
        })
        .await
        .map_err(|error| format!("服务状态检查任务异常结束：{error}"))?
    }

    pub(crate) async fn service_logs(
        &self,
        session_id: &str,
        service: String,
        lines: u16,
    ) -> Result<crate::monitor::ServiceLogsResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::ServiceLogs {
                service,
                lines,
                response: response_sender,
            },
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(15))
                .map_err(|error| format!("等待服务日志失败：{error}"))?
        })
        .await
        .map_err(|error| format!("服务日志读取任务异常结束：{error}"))?
    }

    pub(crate) async fn verify_agent_condition(
        &self,
        session_id: &str,
        verification: AgentBusinessVerification,
    ) -> Result<AgentBusinessVerificationResult, String> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.send(
            session_id,
            SessionCommand::AgentVerify {
                verification,
                response: response_sender,
            },
        )?;
        tauri::async_runtime::spawn_blocking(move || {
            response_receiver
                .recv_timeout(Duration::from_secs(15))
                .map_err(|error| format!("等待 AI 业务验证结果失败：{error}"))?
        })
        .await
        .map_err(|error| format!("AI 业务验证任务异常结束：{error}"))?
    }
}
