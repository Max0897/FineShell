use super::*;

#[derive(Clone, Default)]
pub(crate) struct SftpSessionManager {
    sessions: Arc<Mutex<HashMap<String, SftpHandle>>>,
    transfers: Arc<Mutex<TransferRegistry>>,
}

type TransferKey = (String, String);
type TransferRegistry = HashMap<TransferKey, Arc<TransferControl>>;

impl SftpSessionManager {
    pub(crate) fn read_text_file(
        &self,
        session_id: &str,
        path: String,
    ) -> Result<SftpTextFile, String> {
        let (reply, receiver) = mpsc::channel();
        self.send(session_id, SftpCommand::ReadTextFile { path, reply })?;
        receiver
            .recv()
            .map_err(|_| "SFTP 操作没有返回结果".to_string())?
    }

    pub(crate) fn write_text_file(
        &self,
        session_id: &str,
        path: String,
        content: String,
        original_content: String,
        overwrite: bool,
    ) -> Result<SftpTextFile, String> {
        let (reply, receiver) = mpsc::channel();
        self.send(
            session_id,
            SftpCommand::WriteTextFile {
                path,
                content,
                original_content,
                overwrite,
                reply,
            },
        )?;
        receiver
            .recv()
            .map_err(|_| "SFTP 操作没有返回结果".to_string())?
    }

    pub(super) fn begin_connect(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        if sessions.contains_key(session_id) {
            return Err("该 SFTP 会话已存在".to_string());
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        sessions.insert(
            session_id.to_string(),
            SftpHandle::Connecting(cancelled.clone()),
        );
        Ok(cancelled)
    }

    pub(super) fn activate(
        &self,
        session_id: &str,
        sender: Sender<SftpCommand>,
        auth: SshAuthConfig,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        match sessions.get(session_id) {
            Some(SftpHandle::Connecting(cancelled)) if !cancelled.load(Ordering::Acquire) => {
                sessions.insert(
                    session_id.to_string(),
                    SftpHandle::Connected {
                        sender,
                        auth: Box::new(auth),
                    },
                );
                Ok(())
            }
            _ => Err("SFTP 连接已取消".to_string()),
        }
    }

    pub(super) fn send(&self, session_id: &str, command: SftpCommand) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SFTP 会话不存在或已关闭".to_string())?;
        match handle {
            SftpHandle::Connected { sender, .. } => sender
                .send(command)
                .map_err(|_| "SFTP 会话已停止".to_string()),
            SftpHandle::Connecting(_) => Err("SFTP 会话仍在连接".to_string()),
        }
    }

    pub(super) fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?
            .remove(session_id)
            .ok_or_else(|| "SFTP 会话不存在或已关闭".to_string())?;
        self.cancel_session_transfers(session_id);
        match handle {
            SftpHandle::Connecting(cancelled) => {
                cancelled.store(true, Ordering::Release);
                Ok(())
            }
            SftpHandle::Connected { sender, .. } => sender
                .send(SftpCommand::Close)
                .map_err(|_| "SFTP 会话已停止".to_string()),
        }
    }

    pub(super) fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        self.cancel_session_transfers(session_id);
    }

    pub(super) fn begin_transfer(
        &self,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<(SshAuthConfig, Arc<TransferControl>), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        let auth = match sessions.get(session_id) {
            Some(SftpHandle::Connected { auth, .. }) => auth.as_ref().clone(),
            Some(SftpHandle::Connecting(_)) => return Err("SFTP 会话仍在连接".to_string()),
            None => return Err("SFTP 会话不存在或已关闭".to_string()),
        };
        let key = (session_id.to_string(), transfer_id.to_string());
        let mut transfers = self
            .transfers
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        if transfers.contains_key(&key) {
            return Err("传输任务已存在".to_string());
        }
        let control = Arc::new(TransferControl::default());
        transfers.insert(key, control.clone());
        Ok((auth, control))
    }

    pub(super) fn transfer_control(
        &self,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<Arc<TransferControl>, String> {
        self.transfers
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?
            .get(&(session_id.to_string(), transfer_id.to_string()))
            .cloned()
            .ok_or_else(|| "传输任务不存在或已结束".to_string())
    }

    pub(super) fn finish_transfer(&self, session_id: &str, transfer_id: &str) {
        if let Ok(mut transfers) = self.transfers.lock() {
            transfers.remove(&(session_id.to_string(), transfer_id.to_string()));
        }
    }

    fn cancel_session_transfers(&self, session_id: &str) {
        if let Ok(transfers) = self.transfers.lock() {
            for ((task_session_id, _), control) in transfers.iter() {
                if task_session_id == session_id {
                    control.cancel();
                }
            }
        }
    }
}
