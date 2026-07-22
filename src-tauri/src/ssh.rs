use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, HashType, Session};
use tauri::{AppHandle, Emitter, State};

use crate::credentials;

const SSH_OUTPUT_EVENT: &str = "ssh-output";
const SSH_STATUS_EVENT: &str = "ssh-status";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectRequest {
    session_id: String,
    host_id: String,
    address: String,
    port: u16,
    username: String,
    connect_timeout_seconds: u64,
    expected_fingerprint: Option<String>,
    cols: u32,
    rows: u32,
}

pub(crate) struct SshAuthConfig {
    pub(crate) host_id: String,
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) connect_timeout_seconds: u64,
    pub(crate) expected_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectResult {
    fingerprint: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshStatusPayload {
    session_id: String,
    status: &'static str,
    error: Option<String>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone)]
enum SessionHandle {
    Connecting(Arc<AtomicBool>),
    Connected(Sender<SessionCommand>),
}

#[derive(Clone, Default)]
pub(crate) struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

impl SshSessionManager {
    fn begin_connect(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
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

    fn activate(&self, session_id: &str, sender: Sender<SessionCommand>) -> Result<(), String> {
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

    fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态不可用".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?;
        match handle {
            SessionHandle::Connected(sender) => sender
                .send(command)
                .map_err(|_| "SSH 会话已停止".to_string()),
            SessionHandle::Connecting(_) => Err("SSH 会话仍在连接".to_string()),
        }
    }

    fn disconnect(&self, session_id: &str) -> Result<(), String> {
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

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

fn connect_tcp(config: &SshAuthConfig) -> Result<TcpStream, String> {
    let timeout = Duration::from_secs(config.connect_timeout_seconds.clamp(3, 120));
    let addresses = (config.address.as_str(), config.port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机地址：{error}"))?;
    let mut last_error = None;

    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error
        .map(|error| format!("无法连接到主机：{error}"))
        .unwrap_or_else(|| "主机地址没有可用的网络端点".to_string()))
}

fn host_fingerprint(session: &Session) -> Result<String, String> {
    let hash = session
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| "服务器没有提供可校验的主机指纹".to_string())?;
    Ok(format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
}

fn validate_fingerprint(expected: Option<&str>, actual: &str) -> Result<(), String> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };

    let normalized = if expected.starts_with("SHA256:") {
        expected.to_string()
    } else {
        format!("SHA256:{expected}")
    };

    if normalized == actual {
        Ok(())
    } else {
        Err(format!("主机指纹不匹配，期望 {normalized}，实际 {actual}"))
    }
}

pub(crate) fn connect_authenticated_session(
    config: &SshAuthConfig,
    cancelled: &AtomicBool,
) -> Result<(Session, String), String> {
    let tcp = connect_tcp(config)?;
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

    let mut session = Session::new().map_err(|error| format!("SSH 初始化失败：{error}"))?;
    session.set_timeout(
        config
            .connect_timeout_seconds
            .clamp(3, 120)
            .saturating_mul(1000) as u32,
    );
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

    let fingerprint = host_fingerprint(&session)?;
    validate_fingerprint(config.expected_fingerprint.as_deref(), &fingerprint)?;

    let password = credentials::get_host_password(&config.host_id)?;
    session
        .userauth_password(&config.username, &password)
        .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
    if !session.authenticated() {
        return Err("SSH 认证未通过".to_string());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

    Ok((session, fingerprint))
}

fn emit_output(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let _ = app.emit_to(
        "main",
        SSH_OUTPUT_EVENT,
        SshOutputPayload {
            session_id: session_id.to_string(),
            data: STANDARD_NO_PAD.encode(bytes),
        },
    );
}

fn emit_status(app: &AppHandle, session_id: &str, status: &'static str, error: Option<String>) {
    let _ = app.emit_to(
        "main",
        SSH_STATUS_EVENT,
        SshStatusPayload {
            session_id: session_id.to_string(),
            status,
            error,
        },
    );
}

fn write_pending(channel: &mut Channel, pending: &mut VecDeque<Vec<u8>>) -> Result<bool, String> {
    let mut wrote_data = false;
    while let Some(data) = pending.front_mut() {
        match channel.write(data) {
            Ok(0) => break,
            Ok(written) => {
                data.drain(..written);
                wrote_data = true;
                if data.is_empty() {
                    pending.pop_front();
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(format!("终端输入发送失败：{error}")),
        }
    }
    Ok(wrote_data)
}

fn read_output<R: Read>(reader: &mut R, app: &AppHandle, session_id: &str) -> Result<bool, String> {
    let mut read_data = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                emit_output(app, session_id, &buffer[..size]);
                read_data = true;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(format!("终端输出读取失败：{error}")),
        }
    }
    Ok(read_data)
}

fn run_session(
    app: AppHandle,
    manager: SshSessionManager,
    session_id: String,
    session: Session,
    mut channel: Channel,
    receiver: Receiver<SessionCommand>,
) {
    session.set_blocking(false);
    let mut stderr = channel.stderr();
    let mut pending = VecDeque::new();
    let mut pending_resize = None;
    let mut terminal_error = None;
    let mut closing = false;

    while !closing && !channel.eof() {
        let mut active = false;
        loop {
            match receiver.try_recv() {
                Ok(SessionCommand::Write(data)) => pending.push_back(data),
                Ok(SessionCommand::Resize { cols, rows }) => {
                    pending_resize = Some((cols, rows));
                }
                Ok(SessionCommand::Close) | Err(TryRecvError::Disconnected) => {
                    closing = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if closing {
            break;
        }

        if let Some((cols, rows)) = pending_resize {
            match channel.request_pty_size(cols, rows, None, None) {
                Ok(()) => {
                    pending_resize = None;
                    active = true;
                }
                Err(error) => {
                    let message = error.to_string();
                    let io_error: io::Error = error.into();
                    if io_error.kind() != io::ErrorKind::WouldBlock {
                        terminal_error = Some(format!("调整终端尺寸失败：{message}"));
                        break;
                    }
                }
            }
        }

        match write_pending(&mut channel, &mut pending) {
            Ok(wrote) => active |= wrote,
            Err(error) => {
                terminal_error = Some(error);
                break;
            }
        }
        match read_output(&mut channel, &app, &session_id) {
            Ok(read) => active |= read,
            Err(error) => {
                terminal_error = Some(error);
                break;
            }
        }
        match read_output(&mut stderr, &app, &session_id) {
            Ok(read) => active |= read,
            Err(error) => {
                terminal_error = Some(error);
                break;
            }
        }

        if !active {
            thread::sleep(Duration::from_millis(8));
        }
    }

    let _ = channel.close();
    manager.remove(&session_id);
    emit_status(&app, &session_id, "disconnected", terminal_error);
}

fn connect_session(
    app: AppHandle,
    manager: SshSessionManager,
    request: SshConnectRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<SshConnectResult, String> {
    let auth = SshAuthConfig {
        host_id: request.host_id.clone(),
        address: request.address.clone(),
        port: request.port,
        username: request.username.clone(),
        connect_timeout_seconds: request.connect_timeout_seconds,
        expected_fingerprint: request.expected_fingerprint.clone(),
    };
    let (session, fingerprint) = connect_authenticated_session(&auth, &cancelled)?;

    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建终端通道：{error}"))?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((request.cols.max(1), request.rows.max(1), 0, 0)),
        )
        .map_err(|error| format!("无法创建远程 PTY：{error}"))?;
    channel
        .shell()
        .map_err(|error| format!("无法启动远程 Shell：{error}"))?;
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

    let (sender, receiver) = mpsc::channel();
    manager.activate(&request.session_id, sender)?;
    let worker_manager = manager.clone();
    let worker_session_id = request.session_id.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("ssh-{}", request.session_id))
        .spawn(move || {
            run_session(
                app,
                worker_manager,
                worker_session_id,
                session,
                channel,
                receiver,
            )
        })
    {
        manager.remove(&request.session_id);
        return Err(format!("无法启动 SSH 会话线程：{error}"));
    }

    Ok(SshConnectResult { fingerprint })
}

#[tauri::command]
pub(crate) async fn ssh_connect(
    app: AppHandle,
    manager: State<'_, SshSessionManager>,
    request: SshConnectRequest,
) -> Result<SshConnectResult, String> {
    let manager = manager.inner().clone();
    let session_id = request.session_id.clone();
    let cancelled = manager.begin_connect(&session_id)?;
    let worker_manager = manager.clone();
    let result = match tauri::async_runtime::spawn_blocking(move || {
        connect_session(app, worker_manager, request, cancelled)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            manager.remove(&session_id);
            return Err(format!("SSH 连接任务异常结束：{error}"));
        }
    };
    if result.is_err() {
        manager.remove(&session_id);
    }
    result
}

#[tauri::command]
pub(crate) fn ssh_write(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    manager.send(&session_id, SessionCommand::Write(data))
}

#[tauri::command]
pub(crate) fn ssh_resize(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    manager.send(
        &session_id,
        SessionCommand::Resize {
            cols: cols.max(1),
            rows: rows.max(1),
        },
    )
}

#[tauri::command]
pub(crate) fn ssh_disconnect(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.disconnect(&session_id)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::{validate_fingerprint, SessionCommand, SshSessionManager};

    #[test]
    fn accepts_fingerprint_with_or_without_prefix() {
        let actual = "SHA256:abc123";
        assert!(validate_fingerprint(Some(actual), actual).is_ok());
        assert!(validate_fingerprint(Some("abc123"), actual).is_ok());
        assert!(validate_fingerprint(None, actual).is_ok());
    }

    #[test]
    fn rejects_changed_fingerprint() {
        assert!(validate_fingerprint(Some("SHA256:expected"), "SHA256:actual").is_err());
    }

    #[test]
    fn cancels_a_connection_before_it_becomes_active() {
        let manager = SshSessionManager::default();
        let cancelled = manager.begin_connect("session-1").unwrap();

        manager.disconnect("session-1").unwrap();

        assert!(cancelled.load(Ordering::Acquire));
        let (sender, _) = std::sync::mpsc::channel();
        assert!(manager.activate("session-1", sender).is_err());
    }

    #[test]
    fn forwards_commands_to_an_active_session() {
        let manager = SshSessionManager::default();
        manager.begin_connect("session-1").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        manager.activate("session-1", sender).unwrap();

        manager
            .send("session-1", SessionCommand::Write(vec![1, 2, 3]))
            .unwrap();

        assert!(matches!(
            receiver.recv().unwrap(),
            SessionCommand::Write(data) if data == vec![1, 2, 3]
        ));
    }
}
