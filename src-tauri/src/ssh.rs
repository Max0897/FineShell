use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, HashType, Session};
use tauri::{AppHandle, Emitter, State};

use crate::credentials;
use crate::monitor::{self, NetworkPingResult, ServerMonitorSnapshot};

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
    auth_method: SshAuthMethod,
    private_key_path: Option<String>,
    connect_timeout_seconds: u64,
    keep_alive_interval_seconds: u32,
    expected_fingerprint: Option<String>,
    cols: u32,
    rows: u32,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SshAuthMethod {
    Password,
    PrivateKey,
}

pub(crate) struct SshAuthConfig {
    pub(crate) host_id: String,
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: SshAuthMethod,
    pub(crate) private_key_path: Option<String>,
    pub(crate) connect_timeout_seconds: u64,
    pub(crate) keep_alive_interval_seconds: u32,
    pub(crate) expected_fingerprint: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SshConnectStatus {
    Connected,
    HostKeyVerificationRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshConnectResult {
    status: SshConnectStatus,
    fingerprint: String,
    expected_fingerprint: Option<String>,
}

#[derive(Debug, PartialEq)]
enum FingerprintVerification {
    Trusted,
    Unknown,
    Changed(String),
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
    recoverable: bool,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    Monitor(SyncSender<Result<ServerMonitorSnapshot, String>>),
    Ping {
        target: String,
        response: SyncSender<Result<NetworkPingResult, String>>,
    },
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

fn verify_fingerprint(expected: Option<&str>, actual: &str) -> FingerprintVerification {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return FingerprintVerification::Unknown;
    };
    let normalized = if expected.starts_with("SHA256:") {
        expected.to_string()
    } else {
        format!("SHA256:{expected}")
    };
    if normalized == actual {
        FingerprintVerification::Trusted
    } else {
        FingerprintVerification::Changed(normalized)
    }
}

fn validate_fingerprint(expected: Option<&str>, actual: &str) -> Result<(), String> {
    match verify_fingerprint(expected, actual) {
        FingerprintVerification::Trusted | FingerprintVerification::Unknown => Ok(()),
        FingerprintVerification::Changed(expected) => {
            Err(format!("主机指纹不匹配，期望 {expected}，实际 {actual}"))
        }
    }
}

fn resolve_private_key_path(path: &str) -> PathBuf {
    let Some(relative) = path.strip_prefix("~/") else {
        return PathBuf::from(path);
    };
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(relative))
        .unwrap_or_else(|| PathBuf::from(path))
}

fn configure_keepalive(session: &Session, interval_seconds: u32) {
    if interval_seconds > 0 {
        session.set_keepalive(true, interval_seconds.clamp(5, 300));
    }
}

fn connect_handshaken_session(
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
    Ok((session, fingerprint))
}

fn authenticate_session(session: &Session, config: &SshAuthConfig) -> Result<(), String> {
    match config.auth_method {
        SshAuthMethod::Password => {
            let password = credentials::get_host_password(&config.host_id)?;
            session
                .userauth_password(&config.username, &password)
                .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
        }
        SshAuthMethod::PrivateKey => {
            let private_key_path = config
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "未配置 SSH 私钥文件".to_string())?;
            let private_key = resolve_private_key_path(private_key_path);
            if !private_key.is_file() {
                return Err(format!("SSH 私钥文件不存在：{private_key_path}"));
            }
            let passphrase = credentials::get_private_key_passphrase(&config.host_id)?;
            session
                .userauth_pubkey_file(&config.username, None, &private_key, passphrase.as_deref())
                .map_err(|error| format!("SSH 私钥认证失败：{error}"))?;
        }
    }
    if !session.authenticated() {
        return Err("SSH 认证未通过".to_string());
    }
    Ok(())
}

pub(crate) fn connect_authenticated_session(
    config: &SshAuthConfig,
    cancelled: &AtomicBool,
) -> Result<(Session, String), String> {
    let (session, fingerprint) = connect_handshaken_session(config, cancelled)?;
    validate_fingerprint(config.expected_fingerprint.as_deref(), &fingerprint)?;
    authenticate_session(&session, config)?;
    configure_keepalive(&session, config.keep_alive_interval_seconds);
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

fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: &'static str,
    error: Option<String>,
    recoverable: bool,
) {
    let _ = app.emit_to(
        "main",
        SSH_STATUS_EVENT,
        SshStatusPayload {
            session_id: session_id.to_string(),
            status,
            error,
            recoverable,
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

fn disconnect_status(closing: bool, terminal_error: Option<String>) -> (Option<String>, bool) {
    let recoverable = !closing && terminal_error.is_some();
    let error = if !closing && terminal_error.is_none() {
        Some("远程 Shell 已结束".to_string())
    } else {
        terminal_error
    };
    (error, recoverable)
}

fn run_session(
    app: AppHandle,
    manager: SshSessionManager,
    session_id: String,
    session: Session,
    mut channel: Channel,
    receiver: Receiver<SessionCommand>,
    keep_alive_interval_seconds: u32,
) {
    session.set_blocking(false);
    let mut stderr = channel.stderr();
    let mut pending = VecDeque::new();
    let mut pending_resize = None;
    let mut terminal_error = None;
    let mut closing = false;
    let mut next_keepalive_at = Instant::now() + Duration::from_secs(1);

    while !closing && !channel.eof() {
        let mut active = false;
        loop {
            match receiver.try_recv() {
                Ok(SessionCommand::Write(data)) => pending.push_back(data),
                Ok(SessionCommand::Resize { cols, rows }) => {
                    pending_resize = Some((cols, rows));
                }
                Ok(SessionCommand::Monitor(response)) => {
                    let _ = response.send(monitor::collect_server_snapshot(&session));
                    active = true;
                }
                Ok(SessionCommand::Ping { target, response }) => {
                    let _ = response.send(monitor::collect_ping(&session, &target));
                    active = true;
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

        if keep_alive_interval_seconds > 0 && Instant::now() >= next_keepalive_at {
            match session.keepalive_send() {
                Ok(next_seconds) => {
                    next_keepalive_at =
                        Instant::now() + Duration::from_secs(u64::from(next_seconds.max(1)));
                }
                Err(error) => {
                    let message = error.to_string();
                    let io_error: io::Error = error.into();
                    if io_error.kind() == io::ErrorKind::WouldBlock {
                        next_keepalive_at = Instant::now() + Duration::from_millis(100);
                    } else {
                        terminal_error = Some(format!("SSH 保活失败：{message}"));
                        break;
                    }
                }
            }
        }

        if !active {
            thread::sleep(Duration::from_millis(8));
        }
    }

    let _ = channel.close();
    manager.remove(&session_id);
    let (error, recoverable) = disconnect_status(closing, terminal_error);
    emit_status(&app, &session_id, "disconnected", error, recoverable);
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
        auth_method: request.auth_method,
        private_key_path: request.private_key_path.clone(),
        connect_timeout_seconds: request.connect_timeout_seconds,
        keep_alive_interval_seconds: request.keep_alive_interval_seconds,
        expected_fingerprint: request.expected_fingerprint.clone(),
    };
    let (session, fingerprint) = connect_handshaken_session(&auth, &cancelled)?;
    match verify_fingerprint(auth.expected_fingerprint.as_deref(), &fingerprint) {
        FingerprintVerification::Trusted => {}
        FingerprintVerification::Unknown => {
            return Ok(SshConnectResult {
                status: SshConnectStatus::HostKeyVerificationRequired,
                fingerprint,
                expected_fingerprint: None,
            });
        }
        FingerprintVerification::Changed(expected_fingerprint) => {
            return Ok(SshConnectResult {
                status: SshConnectStatus::HostKeyVerificationRequired,
                fingerprint,
                expected_fingerprint: Some(expected_fingerprint),
            });
        }
    }
    authenticate_session(&session, &auth)?;
    configure_keepalive(&session, auth.keep_alive_interval_seconds);
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

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
                auth.keep_alive_interval_seconds,
            )
        })
    {
        manager.remove(&request.session_id);
        return Err(format!("无法启动 SSH 会话线程：{error}"));
    }

    Ok(SshConnectResult {
        status: SshConnectStatus::Connected,
        fingerprint,
        expected_fingerprint: None,
    })
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
    if !matches!(
        result,
        Ok(ref value) if value.status == SshConnectStatus::Connected
    ) {
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
pub(crate) async fn ssh_monitor_snapshot(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<ServerMonitorSnapshot, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(&session_id, SessionCommand::Monitor(response_sender))?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|error| format!("等待服务器监控数据失败：{error}"))?
    })
    .await
    .map_err(|error| format!("服务器监控任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_ping(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    target: String,
) -> Result<NetworkPingResult, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
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

#[tauri::command]
pub(crate) fn ssh_disconnect(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.disconnect(&session_id)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{
        connect_authenticated_session, connect_handshaken_session, disconnect_status,
        validate_fingerprint, verify_fingerprint, FingerprintVerification, SessionCommand,
        SshAuthConfig, SshAuthMethod, SshSessionManager,
    };

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
    fn classifies_unknown_and_changed_fingerprints() {
        assert_eq!(
            verify_fingerprint(None, "SHA256:actual"),
            FingerprintVerification::Unknown
        );
        assert_eq!(
            verify_fingerprint(Some("expected"), "SHA256:actual"),
            FingerprintVerification::Changed("SHA256:expected".to_string())
        );
    }

    #[test]
    fn only_marks_transport_failures_as_recoverable() {
        let (clean_error, clean_recoverable) = disconnect_status(false, None);
        assert_eq!(clean_error.as_deref(), Some("远程 Shell 已结束"));
        assert!(!clean_recoverable);

        let (transport_error, transport_recoverable) =
            disconnect_status(false, Some("socket closed".to_string()));
        assert_eq!(transport_error.as_deref(), Some("socket closed"));
        assert!(transport_recoverable);
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

    #[test]
    #[ignore = "requires FINESHELL_LIVE_* environment variables and a test private key"]
    fn connects_with_a_live_private_key() -> Result<(), String> {
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
        let private_key_path = std::env::var("FINESHELL_LIVE_PRIVATE_KEY")
            .map_err(|_| "缺少 FINESHELL_LIVE_PRIVATE_KEY".to_string())?;
        let config = SshAuthConfig {
            host_id: "fineshell-live-private-key".to_string(),
            address,
            port,
            username,
            auth_method: SshAuthMethod::PrivateKey,
            private_key_path: Some(private_key_path),
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 5,
            expected_fingerprint: std::env::var("FINESHELL_LIVE_FINGERPRINT").ok(),
        };

        let (session, fingerprint) =
            connect_authenticated_session(&config, &AtomicBool::new(false))?;
        if !session.authenticated() || !fingerprint.starts_with("SHA256:") {
            return Err("私钥认证结果无效".to_string());
        }
        std::thread::sleep(std::time::Duration::from_secs(6));
        session
            .keepalive_send()
            .map_err(|error| format!("SSH 保活测试失败：{error}"))?;
        Ok(())
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_ADDRESS and optional connection settings"]
    fn detects_a_live_unknown_host_before_authentication() -> Result<(), String> {
        let config = SshAuthConfig {
            host_id: "credential-must-not-be-read".to_string(),
            address: std::env::var("FINESHELL_LIVE_ADDRESS")
                .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?,
            port: std::env::var("FINESHELL_LIVE_PORT")
                .unwrap_or_else(|_| "22".to_string())
                .parse::<u16>()
                .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?,
            username: std::env::var("FINESHELL_LIVE_USERNAME")
                .unwrap_or_else(|_| "root".to_string()),
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 15,
            expected_fingerprint: None,
        };

        let (session, fingerprint) = connect_handshaken_session(&config, &AtomicBool::new(false))?;
        if session.authenticated()
            || verify_fingerprint(None, &fingerprint) != FingerprintVerification::Unknown
        {
            return Err("未知主机在认证前的状态无效".to_string());
        }
        Ok(())
    }
}
