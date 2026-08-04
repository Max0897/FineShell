use super::*;

#[derive(Clone, Default)]
pub(crate) struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
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
