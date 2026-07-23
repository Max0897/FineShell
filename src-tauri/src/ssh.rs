use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream},
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
use crate::dynamic_forward::{self, DynamicConnectRequest, DynamicConnectionResult};
use crate::monitor::{
    self, NetworkConnectionsResult, NetworkPingResult, NetworkTraceResult, ServerMonitorSnapshot,
    ServerProcessListResult,
};
use crate::transport::{self, ProxyConfig};

const SSH_OUTPUT_EVENT: &str = "ssh-output";
const SSH_STATUS_EVENT: &str = "ssh-status";
const PORT_FORWARD_STATUS_EVENT: &str = "port-forward-status";

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
    proxy: Option<ProxyConfig>,
    jump_host: Option<JumpHostConfig>,
    #[serde(default)]
    local_port_forwards: Vec<LocalPortForwardRule>,
    #[serde(default)]
    remote_port_forwards: Vec<RemotePortForwardRule>,
    #[serde(default)]
    dynamic_port_forwards: Vec<DynamicPortForwardRule>,
    cols: u32,
    rows: u32,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SshAuthMethod {
    Password,
    PrivateKey,
    Agent,
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
    pub(crate) proxy: Option<ProxyConfig>,
    pub(crate) jump_host: Option<JumpHostConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JumpHostConfig {
    pub(crate) host_id: String,
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: SshAuthMethod,
    pub(crate) private_key_path: Option<String>,
    pub(crate) connect_timeout_seconds: u64,
    pub(crate) keep_alive_interval_seconds: u32,
    pub(crate) expected_fingerprint: Option<String>,
    pub(crate) proxy: Option<ProxyConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalPortForwardRule {
    id: String,
    name: String,
    bind_address: String,
    bind_port: u16,
    target_address: String,
    target_port: u16,
    enabled: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePortForwardRule {
    id: String,
    name: String,
    bind_address: String,
    bind_port: u16,
    target_address: String,
    target_port: u16,
    enabled: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DynamicPortForwardRule {
    id: String,
    name: String,
    bind_address: String,
    bind_port: u16,
    enabled: bool,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PortForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortForwardStatus {
    rule_id: String,
    kind: PortForwardKind,
    status: &'static str,
    bind_address: String,
    bind_port: u16,
    error: Option<String>,
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
    port_forwards: Vec<PortForwardStatus>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortForwardStatusPayload {
    session_id: String,
    rule_id: String,
    kind: PortForwardKind,
    status: &'static str,
    bind_address: String,
    bind_port: u16,
    error: Option<String>,
}

struct ActiveLocalForward {
    rule: LocalPortForwardRule,
    listener: TcpListener,
}

struct ActiveRemoteForward {
    rule: RemotePortForwardRule,
    listener: ssh2::Listener,
    bound_port: u16,
}

struct ActiveDynamicForward {
    rule: DynamicPortForwardRule,
    listener: TcpListener,
}

struct ForwardConnection {
    rule_id: String,
    kind: PortForwardKind,
    socket: TcpStream,
    channel: Channel,
    to_remote: VecDeque<Vec<u8>>,
    to_local: VecDeque<Vec<u8>>,
    socket_closed: bool,
    channel_closed: bool,
    remote_eof_sent: bool,
}

struct RemoteConnectionResult {
    rule_id: String,
    channel: Channel,
    socket: Result<TcpStream, String>,
}

struct SessionRuntimeConfig {
    keep_alive_interval_seconds: u32,
    local_forwards: Vec<ActiveLocalForward>,
    remote_forwards: Vec<ActiveRemoteForward>,
    dynamic_forwards: Vec<ActiveDynamicForward>,
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
    NetworkConnections(SyncSender<Result<NetworkConnectionsResult, String>>),
    TraceRoute {
        target: String,
        response: SyncSender<Result<NetworkTraceResult, String>>,
    },
    Processes(SyncSender<Result<ServerProcessListResult, String>>),
    SignalProcess {
        pid: u32,
        force: bool,
        response: SyncSender<Result<(), String>>,
    },
    StartLocalForward {
        rule: LocalPortForwardRule,
        response: SyncSender<Result<PortForwardStatus, String>>,
    },
    StopLocalForward {
        rule_id: String,
        response: SyncSender<Result<PortForwardStatus, String>>,
    },
    StartRemoteForward {
        rule: RemotePortForwardRule,
        response: SyncSender<Result<PortForwardStatus, String>>,
    },
    StopRemoteForward {
        rule_id: String,
        response: SyncSender<Result<PortForwardStatus, String>>,
    },
    StartDynamicForward {
        rule: DynamicPortForwardRule,
        response: SyncSender<Result<PortForwardStatus, String>>,
    },
    StopDynamicForward {
        rule_id: String,
        response: SyncSender<Result<PortForwardStatus, String>>,
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

fn write_relay_pending<W: Write>(
    writer: &mut W,
    pending: &mut VecDeque<Vec<u8>>,
) -> io::Result<bool> {
    let mut wrote_data = false;
    while let Some(data) = pending.front_mut() {
        match writer.write(data) {
            Ok(0) => break,
            Ok(written) => {
                data.drain(..written);
                wrote_data = true;
                if data.is_empty() {
                    pending.pop_front();
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(error),
        }
    }
    Ok(wrote_data)
}

fn run_jump_relay(
    session: Session,
    mut channel: Channel,
    mut socket: TcpStream,
    keep_alive_interval_seconds: u32,
) {
    session.set_blocking(false);
    if socket.set_nonblocking(true).is_err() {
        return;
    }

    let mut to_jump = VecDeque::new();
    let mut to_target = VecDeque::new();
    let mut socket_closed = false;
    let mut channel_closed = false;
    let mut jump_eof_sent = false;
    let mut next_keepalive_at = Instant::now() + Duration::from_secs(1);
    let mut buffer = [0_u8; 32 * 1024];

    while !channel_closed || !to_target.is_empty() {
        let mut active = false;

        if !socket_closed {
            loop {
                match socket.read(&mut buffer) {
                    Ok(0) => {
                        socket_closed = true;
                        break;
                    }
                    Ok(size) => {
                        to_jump.push_back(buffer[..size].to_vec());
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        socket_closed = true;
                        break;
                    }
                }
            }
        }

        if !channel_closed {
            loop {
                match channel.read(&mut buffer) {
                    Ok(0) if channel.eof() => {
                        channel_closed = true;
                        let _ = socket.shutdown(Shutdown::Write);
                        break;
                    }
                    Ok(0) => break,
                    Ok(size) => {
                        to_target.push_back(buffer[..size].to_vec());
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        channel_closed = true;
                        let _ = socket.shutdown(Shutdown::Write);
                        break;
                    }
                }
            }
        }

        match write_relay_pending(&mut channel, &mut to_jump) {
            Ok(wrote) => active |= wrote,
            Err(_) => break,
        }
        match write_relay_pending(&mut socket, &mut to_target) {
            Ok(wrote) => active |= wrote,
            Err(_) => break,
        }

        if socket_closed && to_jump.is_empty() && !jump_eof_sent {
            match channel.send_eof() {
                Ok(()) => jump_eof_sent = true,
                Err(error) => {
                    let io_error: io::Error = error.into();
                    if io_error.kind() != io::ErrorKind::WouldBlock {
                        break;
                    }
                }
            }
        }

        if keep_alive_interval_seconds > 0 && Instant::now() >= next_keepalive_at {
            match session.keepalive_send() {
                Ok(next_seconds) => {
                    next_keepalive_at =
                        Instant::now() + Duration::from_secs(u64::from(next_seconds.max(1)));
                }
                Err(error) => {
                    let io_error: io::Error = error.into();
                    if io_error.kind() != io::ErrorKind::WouldBlock {
                        break;
                    }
                    next_keepalive_at = Instant::now() + Duration::from_millis(100);
                }
            }
        }

        if socket_closed && channel_closed && to_target.is_empty() {
            break;
        }
        if socket_closed && jump_eof_sent && to_jump.is_empty() && to_target.is_empty() {
            break;
        }
        if !active {
            thread::sleep(Duration::from_millis(4));
        }
    }

    let _ = channel.close();
    let _ = socket.shutdown(Shutdown::Both);
}

fn loopback_pair() -> Result<(TcpStream, TcpStream), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("创建跳板机本地通道失败：{error}"))?;
    let endpoint = listener
        .local_addr()
        .map_err(|error| format!("读取跳板机本地通道地址失败：{error}"))?;
    let client =
        TcpStream::connect(endpoint).map_err(|error| format!("连接跳板机本地通道失败：{error}"))?;
    let (server, _) = listener
        .accept()
        .map_err(|error| format!("接受跳板机本地通道失败：{error}"))?;
    let _ = client.set_nodelay(true);
    let _ = server.set_nodelay(true);
    Ok((client, server))
}

fn connect_via_jump_host(
    target_address: &str,
    target_port: u16,
    jump_host: &JumpHostConfig,
    cancelled: &AtomicBool,
) -> Result<TcpStream, String> {
    if jump_host.expected_fingerprint.is_none() {
        return Err("跳板机尚未确认主机指纹，请先直接连接并信任该主机".to_string());
    }

    let jump_auth = SshAuthConfig {
        host_id: jump_host.host_id.clone(),
        address: jump_host.address.clone(),
        port: jump_host.port,
        username: jump_host.username.clone(),
        auth_method: jump_host.auth_method,
        private_key_path: jump_host.private_key_path.clone(),
        connect_timeout_seconds: jump_host.connect_timeout_seconds,
        keep_alive_interval_seconds: jump_host.keep_alive_interval_seconds,
        expected_fingerprint: jump_host.expected_fingerprint.clone(),
        proxy: jump_host.proxy.clone(),
        jump_host: None,
    };
    let (session, fingerprint) = connect_handshaken_session(&jump_auth, cancelled)
        .map_err(|error| format!("跳板机连接失败：{error}"))?;
    validate_fingerprint(jump_auth.expected_fingerprint.as_deref(), &fingerprint)
        .map_err(|error| format!("跳板机{error}"))?;
    authenticate_session(&session, &jump_auth)
        .map_err(|error| format!("跳板机认证失败：{error}"))?;
    configure_keepalive(&session, jump_auth.keep_alive_interval_seconds);
    if cancelled.load(Ordering::Acquire) {
        return Err("SSH 连接已取消".to_string());
    }

    let channel = session
        .channel_direct_tcpip(target_address, target_port, None)
        .map_err(|error| format!("跳板机无法连接目标主机：{error}"))?;
    let (target_socket, relay_socket) = loopback_pair()?;
    thread::Builder::new()
        .name(format!("ssh-jump-{}", jump_host.host_id))
        .spawn({
            let keep_alive_interval_seconds = jump_auth.keep_alive_interval_seconds;
            move || {
                run_jump_relay(session, channel, relay_socket, keep_alive_interval_seconds);
            }
        })
        .map_err(|error| format!("无法启动跳板机转发线程：{error}"))?;
    Ok(target_socket)
}

fn connect_handshaken_session(
    config: &SshAuthConfig,
    cancelled: &AtomicBool,
) -> Result<(Session, String), String> {
    if config.proxy.is_some() && config.jump_host.is_some() {
        return Err("代理和跳板机不能同时配置".to_string());
    }
    let tcp = match config.jump_host.as_ref() {
        Some(jump_host) => {
            connect_via_jump_host(&config.address, config.port, jump_host, cancelled)?
        }
        None => transport::connect(
            &config.address,
            config.port,
            config.proxy.as_ref(),
            config.connect_timeout_seconds,
        )?,
    };
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
        SshAuthMethod::Agent => {
            session.userauth_agent(&config.username).map_err(|error| {
                format!(
                    "SSH Agent 认证失败：{error}。请确认本机 SSH Agent 正在运行且已加载可用密钥"
                )
            })?;
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

fn local_port_forward_status(
    rule: &LocalPortForwardRule,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Local,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: rule.bind_port,
        error,
    }
}

fn remote_port_forward_status(
    rule: &RemotePortForwardRule,
    bound_port: u16,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Remote,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: bound_port,
        error,
    }
}

fn dynamic_port_forward_status(
    rule: &DynamicPortForwardRule,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Dynamic,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: rule.bind_port,
        error,
    }
}

fn emit_port_forward_status(app: &AppHandle, session_id: &str, status: &PortForwardStatus) {
    let _ = app.emit_to(
        "main",
        PORT_FORWARD_STATUS_EVENT,
        PortForwardStatusPayload {
            session_id: session_id.to_string(),
            rule_id: status.rule_id.clone(),
            kind: status.kind,
            status: status.status,
            bind_address: status.bind_address.clone(),
            bind_port: status.bind_port,
            error: status.error.clone(),
        },
    );
}

fn validate_local_forward_rule(rule: &LocalPortForwardRule) -> Result<SocketAddr, String> {
    if rule.id.trim().is_empty() {
        return Err("端口转发规则缺少标识".to_string());
    }
    if rule.name.trim().is_empty() {
        return Err("端口转发规则缺少名称".to_string());
    }
    if rule.bind_port == 0 || rule.target_port == 0 {
        return Err("端口转发的监听端口和目标端口必须大于 0".to_string());
    }
    let bind_address = rule
        .bind_address
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "监听地址必须是有效的 IP 地址".to_string())?;
    let target_address = rule.target_address.trim();
    if target_address.is_empty() || target_address.chars().any(char::is_control) {
        return Err("端口转发的目标地址无效".to_string());
    }
    Ok(SocketAddr::new(bind_address, rule.bind_port))
}

fn start_local_forward(
    mut rule: LocalPortForwardRule,
) -> Result<(ActiveLocalForward, PortForwardStatus), String> {
    let endpoint = validate_local_forward_rule(&rule)?;
    let listener =
        TcpListener::bind(endpoint).map_err(|error| format!("无法监听 {}：{error}", endpoint))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法启用端口转发的非阻塞监听：{error}"))?;
    rule.enabled = true;
    let status = local_port_forward_status(&rule, "active", None);
    Ok((ActiveLocalForward { rule, listener }, status))
}

fn prepare_local_forwards(
    rules: Vec<LocalPortForwardRule>,
) -> (Vec<ActiveLocalForward>, Vec<PortForwardStatus>) {
    let mut active_forwards = Vec::new();
    let mut statuses = Vec::with_capacity(rules.len());
    let mut rule_ids = HashSet::new();
    let mut endpoints = HashSet::new();

    for rule in rules {
        if !rule_ids.insert(rule.id.clone()) {
            statuses.push(local_port_forward_status(
                &rule,
                "failed",
                Some("端口转发规则标识重复".to_string()),
            ));
            continue;
        }
        if !rule.enabled {
            statuses.push(local_port_forward_status(&rule, "stopped", None));
            continue;
        }
        let endpoint_key = format!("{}:{}", rule.bind_address.trim(), rule.bind_port);
        if !endpoints.insert(endpoint_key) {
            statuses.push(local_port_forward_status(
                &rule,
                "failed",
                Some("监听地址和端口与其他规则重复".to_string()),
            ));
            continue;
        }
        match start_local_forward(rule.clone()) {
            Ok((active, status)) => {
                active_forwards.push(active);
                statuses.push(status);
            }
            Err(error) => statuses.push(local_port_forward_status(&rule, "failed", Some(error))),
        }
    }

    (active_forwards, statuses)
}

fn validate_remote_forward_rule(rule: &RemotePortForwardRule) -> Result<(), String> {
    if rule.id.trim().is_empty() {
        return Err("远程端口转发规则缺少标识".to_string());
    }
    if rule.name.trim().is_empty() {
        return Err("远程端口转发规则缺少名称".to_string());
    }
    if rule.bind_port == 0 || rule.target_port == 0 {
        return Err("远程监听端口和本地目标端口必须大于 0".to_string());
    }
    rule.bind_address
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "远程监听地址必须是有效的 IP 地址".to_string())?;
    let target_address = rule.target_address.trim();
    if target_address.is_empty() || target_address.chars().any(char::is_control) {
        return Err("远程端口转发的本地目标地址无效".to_string());
    }
    Ok(())
}

fn start_remote_forward(
    session: &Session,
    mut rule: RemotePortForwardRule,
) -> Result<(ActiveRemoteForward, PortForwardStatus), String> {
    validate_remote_forward_rule(&rule)?;
    let (listener, bound_port) = session
        .channel_forward_listen(rule.bind_port, Some(rule.bind_address.trim()), Some(16))
        .map_err(|error| {
            format!(
                "服务器无法监听 {}:{}：{error}",
                rule.bind_address, rule.bind_port
            )
        })?;
    rule.enabled = true;
    let status = remote_port_forward_status(&rule, bound_port, "active", None);
    Ok((
        ActiveRemoteForward {
            rule,
            listener,
            bound_port,
        },
        status,
    ))
}

fn prepare_remote_forwards(
    session: &Session,
    rules: Vec<RemotePortForwardRule>,
) -> (Vec<ActiveRemoteForward>, Vec<PortForwardStatus>) {
    let mut active_forwards = Vec::new();
    let mut statuses = Vec::with_capacity(rules.len());
    let mut rule_ids = HashSet::new();
    let mut endpoints = HashSet::new();

    for rule in rules {
        if !rule_ids.insert(rule.id.clone()) {
            statuses.push(remote_port_forward_status(
                &rule,
                rule.bind_port,
                "failed",
                Some("远程端口转发规则标识重复".to_string()),
            ));
            continue;
        }
        if !rule.enabled {
            statuses.push(remote_port_forward_status(
                &rule,
                rule.bind_port,
                "stopped",
                None,
            ));
            continue;
        }
        let endpoint_key = format!("{}:{}", rule.bind_address.trim(), rule.bind_port);
        if !endpoints.insert(endpoint_key) {
            statuses.push(remote_port_forward_status(
                &rule,
                rule.bind_port,
                "failed",
                Some("远程监听地址和端口与其他规则重复".to_string()),
            ));
            continue;
        }
        match start_remote_forward(session, rule.clone()) {
            Ok((active, status)) => {
                active_forwards.push(active);
                statuses.push(status);
            }
            Err(error) => statuses.push(remote_port_forward_status(
                &rule,
                rule.bind_port,
                "failed",
                Some(error),
            )),
        }
    }

    (active_forwards, statuses)
}

fn validate_dynamic_forward_rule(rule: &DynamicPortForwardRule) -> Result<SocketAddr, String> {
    if rule.id.trim().is_empty() {
        return Err("动态端口转发规则缺少标识".to_string());
    }
    if rule.name.trim().is_empty() {
        return Err("动态端口转发规则缺少名称".to_string());
    }
    if rule.bind_port == 0 {
        return Err("动态端口转发的监听端口必须大于 0".to_string());
    }
    let bind_address = rule
        .bind_address
        .trim()
        .parse::<IpAddr>()
        .map_err(|_| "动态端口转发的监听地址必须是有效的 IP 地址".to_string())?;
    Ok(SocketAddr::new(bind_address, rule.bind_port))
}

fn start_dynamic_forward(
    mut rule: DynamicPortForwardRule,
) -> Result<(ActiveDynamicForward, PortForwardStatus), String> {
    let endpoint = validate_dynamic_forward_rule(&rule)?;
    let listener =
        TcpListener::bind(endpoint).map_err(|error| format!("无法监听 {}：{error}", endpoint))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法启用动态端口转发的非阻塞监听：{error}"))?;
    rule.enabled = true;
    let status = dynamic_port_forward_status(&rule, "active", None);
    Ok((ActiveDynamicForward { rule, listener }, status))
}

fn prepare_dynamic_forwards(
    rules: Vec<DynamicPortForwardRule>,
) -> (Vec<ActiveDynamicForward>, Vec<PortForwardStatus>) {
    let mut active_forwards = Vec::new();
    let mut statuses = Vec::with_capacity(rules.len());
    let mut rule_ids = HashSet::new();
    let mut endpoints = HashSet::new();

    for rule in rules {
        if !rule_ids.insert(rule.id.clone()) {
            statuses.push(dynamic_port_forward_status(
                &rule,
                "failed",
                Some("动态端口转发规则标识重复".to_string()),
            ));
            continue;
        }
        if !rule.enabled {
            statuses.push(dynamic_port_forward_status(&rule, "stopped", None));
            continue;
        }
        let endpoint_key = format!("{}:{}", rule.bind_address.trim(), rule.bind_port);
        if !endpoints.insert(endpoint_key) {
            statuses.push(dynamic_port_forward_status(
                &rule,
                "failed",
                Some("监听地址和端口与其他动态转发规则重复".to_string()),
            ));
            continue;
        }
        match start_dynamic_forward(rule.clone()) {
            Ok((active, status)) => {
                active_forwards.push(active);
                statuses.push(status);
            }
            Err(error) => statuses.push(dynamic_port_forward_status(&rule, "failed", Some(error))),
        }
    }

    (active_forwards, statuses)
}

fn open_local_forward_connection(
    session: &Session,
    forward: &ActiveLocalForward,
    socket: TcpStream,
    peer: SocketAddr,
) -> Result<ForwardConnection, String> {
    let originator_address = peer.ip().to_string();
    session.set_blocking(true);
    let channel_result = session.channel_direct_tcpip(
        forward.rule.target_address.trim(),
        forward.rule.target_port,
        Some((&originator_address, peer.port())),
    );
    session.set_blocking(false);
    let channel = channel_result.map_err(|error| {
        format!(
            "无法连接目标 {}:{}：{error}",
            forward.rule.target_address, forward.rule.target_port
        )
    })?;
    ForwardConnection::new(
        forward.rule.id.clone(),
        PortForwardKind::Local,
        socket,
        channel,
    )
}

fn open_dynamic_forward_channel(
    session: &Session,
    target_address: &str,
    target_port: u16,
    peer: SocketAddr,
) -> Result<Channel, String> {
    let target_address = target_address.trim();
    if target_address.is_empty() || target_address.chars().any(char::is_control) {
        return Err("SOCKS5 目标地址无效".to_string());
    }
    if target_port == 0 {
        return Err("SOCKS5 目标端口必须大于 0".to_string());
    }
    let originator_address = peer.ip().to_string();
    session.set_blocking(true);
    let channel_result = session.channel_direct_tcpip(
        target_address,
        target_port,
        Some((&originator_address, peer.port())),
    );
    session.set_blocking(false);
    channel_result
        .map_err(|error| format!("无法通过 SSH 连接目标 {target_address}:{target_port}：{error}"))
}

impl ForwardConnection {
    fn new(
        rule_id: String,
        kind: PortForwardKind,
        socket: TcpStream,
        channel: Channel,
    ) -> Result<Self, String> {
        socket
            .set_nonblocking(true)
            .map_err(|error| format!("无法启用转发连接的非阻塞模式：{error}"))?;
        let _ = socket.set_nodelay(true);
        Ok(Self {
            rule_id,
            kind,
            socket,
            channel,
            to_remote: VecDeque::new(),
            to_local: VecDeque::new(),
            socket_closed: false,
            channel_closed: false,
            remote_eof_sent: false,
        })
    }

    fn poll(&mut self) -> Result<(bool, bool), String> {
        let mut active = false;
        let mut buffer = [0_u8; 32 * 1024];

        if !self.socket_closed {
            loop {
                match self.socket.read(&mut buffer) {
                    Ok(0) => {
                        self.socket_closed = true;
                        break;
                    }
                    Ok(size) => {
                        self.to_remote.push_back(buffer[..size].to_vec());
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(format!("读取本地转发连接失败：{error}")),
                }
            }
        }

        if !self.channel_closed {
            loop {
                match self.channel.read(&mut buffer) {
                    Ok(0) if self.channel.eof() => {
                        self.channel_closed = true;
                        let _ = self.socket.shutdown(Shutdown::Write);
                        break;
                    }
                    Ok(0) => break,
                    Ok(size) => {
                        self.to_local.push_back(buffer[..size].to_vec());
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(format!("读取远端转发连接失败：{error}")),
                }
            }
        }

        active |= write_relay_pending(&mut self.channel, &mut self.to_remote)
            .map_err(|error| format!("写入远端转发连接失败：{error}"))?;
        active |= write_relay_pending(&mut self.socket, &mut self.to_local)
            .map_err(|error| format!("写入本地转发连接失败：{error}"))?;

        if self.socket_closed && self.to_remote.is_empty() && !self.remote_eof_sent {
            match self.channel.send_eof() {
                Ok(()) => self.remote_eof_sent = true,
                Err(error) => {
                    let message = error.to_string();
                    let io_error: io::Error = error.into();
                    if io_error.kind() != io::ErrorKind::WouldBlock {
                        return Err(format!("关闭远端转发写入失败：{message}"));
                    }
                }
            }
        }

        let finished = self.socket_closed
            && self.channel_closed
            && self.to_remote.is_empty()
            && self.to_local.is_empty();
        Ok((active, finished))
    }
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
    runtime: SessionRuntimeConfig,
) {
    let SessionRuntimeConfig {
        keep_alive_interval_seconds,
        mut local_forwards,
        mut remote_forwards,
        mut dynamic_forwards,
    } = runtime;
    session.set_blocking(false);
    let mut stderr = channel.stderr();
    let mut pending = VecDeque::new();
    let mut pending_resize = None;
    let mut terminal_error = None;
    let mut closing = false;
    let mut forward_connections = Vec::<ForwardConnection>::new();
    let (remote_connection_sender, remote_connection_receiver) =
        mpsc::channel::<RemoteConnectionResult>();
    let mut pending_remote_connections = HashMap::<String, usize>::new();
    let (dynamic_request_sender, dynamic_request_receiver) =
        mpsc::channel::<DynamicConnectRequest>();
    let (dynamic_connection_sender, dynamic_connection_receiver) =
        mpsc::channel::<DynamicConnectionResult>();
    let mut pending_dynamic_connections = HashMap::<String, usize>::new();
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
                Ok(SessionCommand::NetworkConnections(response)) => {
                    let _ = response.send(monitor::collect_network_connections(&session));
                    active = true;
                }
                Ok(SessionCommand::TraceRoute { target, response }) => {
                    let _ = response.send(monitor::collect_trace_route(&session, &target));
                    active = true;
                }
                Ok(SessionCommand::Processes(response)) => {
                    let _ = response.send(monitor::collect_processes(&session));
                    active = true;
                }
                Ok(SessionCommand::SignalProcess {
                    pid,
                    force,
                    response,
                }) => {
                    let _ = response.send(monitor::signal_process(&session, pid, force));
                    active = true;
                }
                Ok(SessionCommand::StartLocalForward { rule, response }) => {
                    let duplicate_id = local_forwards
                        .iter()
                        .any(|forward| forward.rule.id == rule.id);
                    let duplicate_endpoint =
                        validate_local_forward_rule(&rule)
                            .ok()
                            .is_some_and(|endpoint| {
                                local_forwards.iter().any(|forward| {
                                    forward.listener.local_addr().ok() == Some(endpoint)
                                })
                            });
                    let result = if duplicate_id {
                        Err("该端口转发规则已经启动".to_string())
                    } else if duplicate_endpoint {
                        Err("监听地址和端口已被其他转发规则使用".to_string())
                    } else {
                        start_local_forward(rule).map(|(forward, status)| {
                            local_forwards.push(forward);
                            emit_port_forward_status(&app, &session_id, &status);
                            status
                        })
                    };
                    let _ = response.send(result);
                    active = true;
                }
                Ok(SessionCommand::StopLocalForward { rule_id, response }) => {
                    let result = local_forwards
                        .iter()
                        .position(|forward| forward.rule.id == rule_id)
                        .map(|index| {
                            let forward = local_forwards.remove(index);
                            forward_connections.retain(|connection| {
                                connection.kind != PortForwardKind::Local
                                    || connection.rule_id != rule_id
                            });
                            let status = local_port_forward_status(&forward.rule, "stopped", None);
                            emit_port_forward_status(&app, &session_id, &status);
                            status
                        })
                        .ok_or_else(|| "该端口转发规则尚未启动".to_string());
                    let _ = response.send(result);
                    active = true;
                }
                Ok(SessionCommand::StartRemoteForward { rule, response }) => {
                    let duplicate_id = remote_forwards
                        .iter()
                        .any(|forward| forward.rule.id == rule.id);
                    let duplicate_endpoint = remote_forwards.iter().any(|forward| {
                        forward.rule.bind_address.trim() == rule.bind_address.trim()
                            && forward.rule.bind_port == rule.bind_port
                    });
                    let result = if duplicate_id {
                        Err("该远程端口转发规则已经启动".to_string())
                    } else if duplicate_endpoint {
                        Err("远程监听地址和端口已被其他转发规则使用".to_string())
                    } else {
                        session.set_blocking(true);
                        let result =
                            start_remote_forward(&session, rule).map(|(forward, status)| {
                                remote_forwards.push(forward);
                                emit_port_forward_status(&app, &session_id, &status);
                                status
                            });
                        session.set_blocking(false);
                        result
                    };
                    let _ = response.send(result);
                    active = true;
                }
                Ok(SessionCommand::StopRemoteForward { rule_id, response }) => {
                    let result = remote_forwards
                        .iter()
                        .position(|forward| forward.rule.id == rule_id)
                        .map(|index| {
                            session.set_blocking(true);
                            let forward = remote_forwards.remove(index);
                            let status = remote_port_forward_status(
                                &forward.rule,
                                forward.bound_port,
                                "stopped",
                                None,
                            );
                            drop(forward);
                            session.set_blocking(false);
                            forward_connections.retain(|connection| {
                                connection.kind != PortForwardKind::Remote
                                    || connection.rule_id != rule_id
                            });
                            emit_port_forward_status(&app, &session_id, &status);
                            status
                        })
                        .ok_or_else(|| "该远程端口转发规则尚未启动".to_string());
                    let _ = response.send(result);
                    active = true;
                }
                Ok(SessionCommand::StartDynamicForward { rule, response }) => {
                    let duplicate_id = dynamic_forwards
                        .iter()
                        .any(|forward| forward.rule.id == rule.id);
                    let duplicate_endpoint =
                        validate_dynamic_forward_rule(&rule)
                            .ok()
                            .is_some_and(|endpoint| {
                                dynamic_forwards.iter().any(|forward| {
                                    forward.listener.local_addr().ok() == Some(endpoint)
                                })
                            });
                    let result = if duplicate_id {
                        Err("该动态端口转发规则已经启动".to_string())
                    } else if duplicate_endpoint {
                        Err("监听地址和端口已被其他动态转发规则使用".to_string())
                    } else {
                        start_dynamic_forward(rule).map(|(forward, status)| {
                            dynamic_forwards.push(forward);
                            emit_port_forward_status(&app, &session_id, &status);
                            status
                        })
                    };
                    let _ = response.send(result);
                    active = true;
                }
                Ok(SessionCommand::StopDynamicForward { rule_id, response }) => {
                    let result = dynamic_forwards
                        .iter()
                        .position(|forward| forward.rule.id == rule_id)
                        .map(|index| {
                            let forward = dynamic_forwards.remove(index);
                            forward_connections.retain(|connection| {
                                connection.kind != PortForwardKind::Dynamic
                                    || connection.rule_id != rule_id
                            });
                            let status =
                                dynamic_port_forward_status(&forward.rule, "stopped", None);
                            emit_port_forward_status(&app, &session_id, &status);
                            status
                        })
                        .ok_or_else(|| "该动态端口转发规则尚未启动".to_string());
                    let _ = response.send(result);
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

        let mut forward_index = 0;
        while forward_index < local_forwards.len() {
            let mut listener_failed = None;
            loop {
                match local_forwards[forward_index].listener.accept() {
                    Ok((socket, peer)) => match open_local_forward_connection(
                        &session,
                        &local_forwards[forward_index],
                        socket,
                        peer,
                    ) {
                        Ok(connection) => {
                            let status = local_port_forward_status(
                                &local_forwards[forward_index].rule,
                                "active",
                                None,
                            );
                            emit_port_forward_status(&app, &session_id, &status);
                            forward_connections.push(connection);
                            active = true;
                        }
                        Err(error) => {
                            let status = local_port_forward_status(
                                &local_forwards[forward_index].rule,
                                "active",
                                Some(error),
                            );
                            emit_port_forward_status(&app, &session_id, &status);
                        }
                    },
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => {
                        listener_failed = Some(format!("本地端口监听失败：{error}"));
                        break;
                    }
                }
            }
            if let Some(error) = listener_failed {
                let forward = local_forwards.remove(forward_index);
                forward_connections.retain(|connection| {
                    connection.kind != PortForwardKind::Local
                        || connection.rule_id != forward.rule.id
                });
                let status = local_port_forward_status(&forward.rule, "failed", Some(error));
                emit_port_forward_status(&app, &session_id, &status);
            } else {
                forward_index += 1;
            }
        }

        let mut dynamic_forward_index = 0;
        while dynamic_forward_index < dynamic_forwards.len() {
            let mut listener_failed = None;
            loop {
                match dynamic_forwards[dynamic_forward_index].listener.accept() {
                    Ok((socket, peer)) => {
                        let rule = dynamic_forwards[dynamic_forward_index].rule.clone();
                        let connection_count = forward_connections
                            .iter()
                            .filter(|connection| {
                                connection.kind == PortForwardKind::Dynamic
                                    && connection.rule_id == rule.id
                            })
                            .count()
                            + pending_dynamic_connections
                                .get(&rule.id)
                                .copied()
                                .unwrap_or(0);
                        if connection_count >= 32 {
                            let status = dynamic_port_forward_status(
                                &rule,
                                "active",
                                Some("动态转发并发连接数已达到 32 条".to_string()),
                            );
                            emit_port_forward_status(&app, &session_id, &status);
                            drop(socket);
                            continue;
                        }

                        *pending_dynamic_connections
                            .entry(rule.id.clone())
                            .or_insert(0) += 1;
                        if let Err(error) = dynamic_forward::spawn_socks5_handshake(
                            rule.id.clone(),
                            socket,
                            peer,
                            dynamic_request_sender.clone(),
                            dynamic_connection_sender.clone(),
                        ) {
                            if let Some(count) = pending_dynamic_connections.get_mut(&rule.id) {
                                *count = count.saturating_sub(1);
                            }
                            let status = dynamic_port_forward_status(&rule, "active", Some(error));
                            emit_port_forward_status(&app, &session_id, &status);
                        }
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => {
                        listener_failed = Some(format!("动态端口监听失败：{error}"));
                        break;
                    }
                }
            }
            if let Some(error) = listener_failed {
                let forward = dynamic_forwards.remove(dynamic_forward_index);
                forward_connections.retain(|connection| {
                    connection.kind != PortForwardKind::Dynamic
                        || connection.rule_id != forward.rule.id
                });
                let status = dynamic_port_forward_status(&forward.rule, "failed", Some(error));
                emit_port_forward_status(&app, &session_id, &status);
            } else {
                dynamic_forward_index += 1;
            }
        }

        while let Ok(request) = dynamic_request_receiver.try_recv() {
            let result = if dynamic_forwards
                .iter()
                .any(|forward| forward.rule.id == request.rule_id)
            {
                open_dynamic_forward_channel(
                    &session,
                    &request.target_address,
                    request.target_port,
                    request.peer,
                )
            } else {
                Err("动态端口转发规则已停止".to_string())
            };
            let _ = request.response.send(result);
            active = true;
        }

        let mut remote_forward_index = 0;
        while remote_forward_index < remote_forwards.len() {
            let mut listener_failed = None;
            loop {
                match remote_forwards[remote_forward_index].listener.accept() {
                    Ok(channel) => {
                        let rule = remote_forwards[remote_forward_index].rule.clone();
                        let connection_count = forward_connections
                            .iter()
                            .filter(|connection| {
                                connection.kind == PortForwardKind::Remote
                                    && connection.rule_id == rule.id
                            })
                            .count()
                            + pending_remote_connections
                                .get(&rule.id)
                                .copied()
                                .unwrap_or(0);
                        if connection_count >= 32 {
                            let status = remote_port_forward_status(
                                &rule,
                                remote_forwards[remote_forward_index].bound_port,
                                "active",
                                Some("远程转发并发连接数已达到 32 条".to_string()),
                            );
                            emit_port_forward_status(&app, &session_id, &status);
                            drop(channel);
                            continue;
                        }

                        *pending_remote_connections
                            .entry(rule.id.clone())
                            .or_insert(0) += 1;
                        let result_sender = remote_connection_sender.clone();
                        let rule_id = rule.id.clone();
                        let connection_rule = rule.clone();
                        let thread_result = thread::Builder::new()
                            .name("ssh-remote-forward-connect".to_string())
                            .spawn(move || {
                                let socket = transport::connect(
                                    connection_rule.target_address.trim(),
                                    connection_rule.target_port,
                                    None,
                                    10,
                                )
                                .map_err(|error| format!("连接本地目标失败：{error}"));
                                let _ = result_sender.send(RemoteConnectionResult {
                                    rule_id,
                                    channel,
                                    socket,
                                });
                            });
                        if let Err(error) = thread_result {
                            if let Some(count) = pending_remote_connections.get_mut(&rule.id) {
                                *count = count.saturating_sub(1);
                            }
                            let status = remote_port_forward_status(
                                &rule,
                                remote_forwards[remote_forward_index].bound_port,
                                "active",
                                Some(format!("无法启动本地目标连接任务：{error}")),
                            );
                            emit_port_forward_status(&app, &session_id, &status);
                        }
                        active = true;
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let io_error: io::Error = error.into();
                        if io_error.kind() == io::ErrorKind::WouldBlock {
                            break;
                        }
                        listener_failed = Some(format!("远程端口监听失败：{message}"));
                        break;
                    }
                }
            }
            if let Some(error) = listener_failed {
                session.set_blocking(true);
                let forward = remote_forwards.remove(remote_forward_index);
                let rule_id = forward.rule.id.clone();
                let status = remote_port_forward_status(
                    &forward.rule,
                    forward.bound_port,
                    "failed",
                    Some(error),
                );
                drop(forward);
                session.set_blocking(false);
                forward_connections.retain(|connection| {
                    connection.kind != PortForwardKind::Remote || connection.rule_id != rule_id
                });
                emit_port_forward_status(&app, &session_id, &status);
            } else {
                remote_forward_index += 1;
            }
        }

        while let Ok(result) = remote_connection_receiver.try_recv() {
            if let Some(count) = pending_remote_connections.get_mut(&result.rule_id) {
                *count = count.saturating_sub(1);
            }
            let Some(forward) = remote_forwards
                .iter()
                .find(|forward| forward.rule.id == result.rule_id)
            else {
                continue;
            };
            match result.socket.and_then(|socket| {
                ForwardConnection::new(
                    result.rule_id,
                    PortForwardKind::Remote,
                    socket,
                    result.channel,
                )
            }) {
                Ok(connection) => {
                    let status = remote_port_forward_status(
                        &forward.rule,
                        forward.bound_port,
                        "active",
                        None,
                    );
                    emit_port_forward_status(&app, &session_id, &status);
                    forward_connections.push(connection);
                }
                Err(error) => {
                    let status = remote_port_forward_status(
                        &forward.rule,
                        forward.bound_port,
                        "active",
                        Some(error),
                    );
                    emit_port_forward_status(&app, &session_id, &status);
                }
            }
            active = true;
        }

        while let Ok(result) = dynamic_connection_receiver.try_recv() {
            if let Some(count) = pending_dynamic_connections.get_mut(&result.rule_id) {
                *count = count.saturating_sub(1);
            }
            let Some(forward) = dynamic_forwards
                .iter()
                .find(|forward| forward.rule.id == result.rule_id)
            else {
                continue;
            };
            match result.result.and_then(|(socket, channel)| {
                ForwardConnection::new(result.rule_id, PortForwardKind::Dynamic, socket, channel)
            }) {
                Ok(connection) => {
                    let status = dynamic_port_forward_status(&forward.rule, "active", None);
                    emit_port_forward_status(&app, &session_id, &status);
                    forward_connections.push(connection);
                }
                Err(error) => {
                    let status = dynamic_port_forward_status(&forward.rule, "active", Some(error));
                    emit_port_forward_status(&app, &session_id, &status);
                }
            }
            active = true;
        }

        let mut connection_index = 0;
        while connection_index < forward_connections.len() {
            match forward_connections[connection_index].poll() {
                Ok((connection_active, finished)) => {
                    active |= connection_active;
                    if finished {
                        forward_connections.remove(connection_index);
                    } else {
                        connection_index += 1;
                    }
                }
                Err(error) => {
                    let rule_id = forward_connections[connection_index].rule_id.clone();
                    let kind = forward_connections[connection_index].kind;
                    forward_connections.remove(connection_index);
                    match kind {
                        PortForwardKind::Local => {
                            if let Some(forward) = local_forwards
                                .iter()
                                .find(|forward| forward.rule.id == rule_id)
                            {
                                let status =
                                    local_port_forward_status(&forward.rule, "active", Some(error));
                                emit_port_forward_status(&app, &session_id, &status);
                            }
                        }
                        PortForwardKind::Remote => {
                            if let Some(forward) = remote_forwards
                                .iter()
                                .find(|forward| forward.rule.id == rule_id)
                            {
                                let status = remote_port_forward_status(
                                    &forward.rule,
                                    forward.bound_port,
                                    "active",
                                    Some(error),
                                );
                                emit_port_forward_status(&app, &session_id, &status);
                            }
                        }
                        PortForwardKind::Dynamic => {
                            if let Some(forward) = dynamic_forwards
                                .iter()
                                .find(|forward| forward.rule.id == rule_id)
                            {
                                let status = dynamic_port_forward_status(
                                    &forward.rule,
                                    "active",
                                    Some(error),
                                );
                                emit_port_forward_status(&app, &session_id, &status);
                            }
                        }
                    }
                }
            }
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
        proxy: request.proxy.clone(),
        jump_host: request.jump_host.clone(),
    };
    let (session, fingerprint) = connect_handshaken_session(&auth, &cancelled)?;
    match verify_fingerprint(auth.expected_fingerprint.as_deref(), &fingerprint) {
        FingerprintVerification::Trusted => {}
        FingerprintVerification::Unknown => {
            return Ok(SshConnectResult {
                status: SshConnectStatus::HostKeyVerificationRequired,
                fingerprint,
                expected_fingerprint: None,
                port_forwards: Vec::new(),
            });
        }
        FingerprintVerification::Changed(expected_fingerprint) => {
            return Ok(SshConnectResult {
                status: SshConnectStatus::HostKeyVerificationRequired,
                fingerprint,
                expected_fingerprint: Some(expected_fingerprint),
                port_forwards: Vec::new(),
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

    let (local_forwards, mut port_forwards) = prepare_local_forwards(request.local_port_forwards);
    let (remote_forwards, remote_statuses) =
        prepare_remote_forwards(&session, request.remote_port_forwards);
    port_forwards.extend(remote_statuses);
    let (dynamic_forwards, dynamic_statuses) =
        prepare_dynamic_forwards(request.dynamic_port_forwards);
    port_forwards.extend(dynamic_statuses);

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
                SessionRuntimeConfig {
                    keep_alive_interval_seconds: auth.keep_alive_interval_seconds,
                    local_forwards,
                    remote_forwards,
                    dynamic_forwards,
                },
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
        port_forwards,
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
pub(crate) async fn ssh_network_connections(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<NetworkConnectionsResult, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
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

#[tauri::command]
pub(crate) async fn ssh_trace_route(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    target: String,
) -> Result<NetworkTraceResult, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
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

#[tauri::command]
pub(crate) async fn ssh_processes(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<ServerProcessListResult, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(&session_id, SessionCommand::Processes(response_sender))?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待进程列表失败：{error}"))?
    })
    .await
    .map_err(|error| format!("进程采集任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_signal_process(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    pid: u32,
    force: bool,
) -> Result<(), String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::SignalProcess {
            pid,
            force,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待进程操作结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("进程操作任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_start_local_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule: LocalPortForwardRule,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StartLocalForward {
            rule,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待端口转发启动结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("端口转发启动任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_stop_local_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule_id: String,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StopLocalForward {
            rule_id,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待端口转发停止结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("端口转发停止任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_start_remote_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule: RemotePortForwardRule,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StartRemoteForward {
            rule,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待远程端口转发启动结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("远程端口转发启动任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_stop_remote_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule_id: String,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StopRemoteForward {
            rule_id,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待远程端口转发停止结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("远程端口转发停止任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_start_dynamic_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule: DynamicPortForwardRule,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StartDynamicForward {
            rule,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待动态端口转发启动结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("动态端口转发启动任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn ssh_stop_dynamic_forward(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    rule_id: String,
) -> Result<PortForwardStatus, String> {
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    manager.send(
        &session_id,
        SessionCommand::StopDynamicForward {
            rule_id,
            response: response_sender,
        },
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待动态端口转发停止结果失败：{error}"))?
    })
    .await
    .map_err(|error| format!("动态端口转发停止任务异常结束：{error}"))?
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
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use crate::dynamic_forward::{self, DynamicConnectRequest, DynamicConnectionResult};

    use super::{
        connect_authenticated_session, connect_handshaken_session, disconnect_status,
        loopback_pair, open_dynamic_forward_channel, open_local_forward_connection,
        start_dynamic_forward, start_local_forward, start_remote_forward,
        validate_dynamic_forward_rule, validate_fingerprint, validate_remote_forward_rule,
        verify_fingerprint, DynamicPortForwardRule, FingerprintVerification, ForwardConnection,
        JumpHostConfig, LocalPortForwardRule, PortForwardKind, RemotePortForwardRule,
        SessionCommand, SshAuthConfig, SshAuthMethod, SshSessionManager,
    };

    #[test]
    fn deserializes_ssh_agent_authentication() {
        let method = serde_json::from_str::<SshAuthMethod>("\"agent\"");
        assert!(method.is_ok());
    }

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
    fn creates_a_bidirectional_loopback_pair_for_jump_relay() {
        let (mut client, mut relay) = loopback_pair().unwrap();
        client.write_all(b"target").unwrap();
        let mut from_target = [0_u8; 6];
        relay.read_exact(&mut from_target).unwrap();
        assert_eq!(&from_target, b"target");

        relay.write_all(b"jump").unwrap();
        let mut from_jump = [0_u8; 4];
        client.read_exact(&mut from_jump).unwrap();
        assert_eq!(&from_jump, b"jump");
    }

    #[test]
    fn starts_and_reserves_a_local_forward_listener() {
        let available = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = available.local_addr().unwrap().port();
        drop(available);
        let rule = LocalPortForwardRule {
            id: "forward-1".to_string(),
            name: "Web".to_string(),
            bind_address: "127.0.0.1".to_string(),
            bind_port: port,
            target_address: "127.0.0.1".to_string(),
            target_port: 80,
            enabled: true,
        };

        let (forward, status) = start_local_forward(rule.clone()).unwrap();
        assert_eq!(status.status, "active");
        TcpStream::connect(forward.listener.local_addr().unwrap()).unwrap();
        assert!(start_local_forward(rule).is_err());
    }

    #[test]
    fn rejects_invalid_local_forward_addresses() {
        let rule = LocalPortForwardRule {
            id: "forward-1".to_string(),
            name: "Web".to_string(),
            bind_address: "localhost".to_string(),
            bind_port: 8080,
            target_address: "127.0.0.1".to_string(),
            target_port: 80,
            enabled: true,
        };

        assert_eq!(
            start_local_forward(rule).err().unwrap(),
            "监听地址必须是有效的 IP 地址"
        );
    }

    #[test]
    fn rejects_invalid_remote_forward_addresses() {
        let rule = RemotePortForwardRule {
            id: "remote-forward-1".to_string(),
            name: "Preview".to_string(),
            bind_address: "localhost".to_string(),
            bind_port: 9000,
            target_address: "127.0.0.1".to_string(),
            target_port: 3000,
            enabled: true,
        };

        assert_eq!(
            validate_remote_forward_rule(&rule).err().unwrap(),
            "远程监听地址必须是有效的 IP 地址"
        );
    }

    #[test]
    fn starts_and_validates_a_dynamic_forward_listener() {
        let available = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = available.local_addr().unwrap().port();
        drop(available);
        let rule = DynamicPortForwardRule {
            id: "dynamic-forward-1".to_string(),
            name: "Browser proxy".to_string(),
            bind_address: "127.0.0.1".to_string(),
            bind_port: port,
            enabled: true,
        };

        let (forward, status) = start_dynamic_forward(rule.clone()).unwrap();
        assert_eq!(status.status, "active");
        TcpStream::connect(forward.listener.local_addr().unwrap()).unwrap();
        assert!(start_dynamic_forward(rule).is_err());

        let invalid_rule = DynamicPortForwardRule {
            id: "dynamic-forward-2".to_string(),
            name: "Invalid proxy".to_string(),
            bind_address: "localhost".to_string(),
            bind_port: 1080,
            enabled: true,
        };
        assert_eq!(
            validate_dynamic_forward_rule(&invalid_rule).err().unwrap(),
            "动态端口转发的监听地址必须是有效的 IP 地址"
        );
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_* environment variables and a stored password"]
    fn forwards_a_live_ssh_banner_through_a_local_listener() -> Result<(), String> {
        let host_id = std::env::var("FINESHELL_LIVE_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_HOST_ID".to_string())?;
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
        let config = SshAuthConfig {
            host_id,
            address: address.clone(),
            port,
            username,
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 5,
            expected_fingerprint: std::env::var("FINESHELL_LIVE_FINGERPRINT").ok(),
            proxy: None,
            jump_host: None,
        };
        let (session, _) = connect_authenticated_session(&config, &AtomicBool::new(false))?;

        let available = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("查找本地测试端口失败：{error}"))?;
        let bind_port = available
            .local_addr()
            .map_err(|error| format!("读取本地测试端口失败：{error}"))?
            .port();
        drop(available);
        let (forward, _) = start_local_forward(LocalPortForwardRule {
            id: "live-forward".to_string(),
            name: "SSH banner".to_string(),
            bind_address: "127.0.0.1".to_string(),
            bind_port,
            target_address: address,
            target_port: port,
            enabled: true,
        })?;
        let mut client = TcpStream::connect(
            forward
                .listener
                .local_addr()
                .map_err(|error| format!("读取转发监听地址失败：{error}"))?,
        )
        .map_err(|error| format!("连接本地转发监听失败：{error}"))?;
        client
            .set_nonblocking(true)
            .map_err(|error| format!("设置测试连接非阻塞模式失败：{error}"))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let (socket, peer) = loop {
            match forward.listener.accept() {
                Ok(connection) => break connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("等待本地转发连接超时".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(format!("接受本地转发连接失败：{error}")),
            }
        };
        let mut relay = open_local_forward_connection(&session, &forward, socket, peer)?;
        let mut banner = Vec::new();
        let mut buffer = [0_u8; 256];
        while Instant::now() < deadline {
            let _ = relay.poll()?;
            match client.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    banner.extend_from_slice(&buffer[..size]);
                    if banner.starts_with(b"SSH-") && banner.contains(&b'\n') {
                        return Ok(());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("读取转发后的 SSH 标识失败：{error}")),
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        Err(format!(
            "未收到有效的 SSH 服务标识：{}",
            String::from_utf8_lossy(&banner)
        ))
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_* environment variables and a stored password"]
    fn forwards_a_live_ssh_banner_through_a_dynamic_socks5_listener() -> Result<(), String> {
        let host_id = std::env::var("FINESHELL_LIVE_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_HOST_ID".to_string())?;
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
        let config = SshAuthConfig {
            host_id,
            address: address.clone(),
            port,
            username,
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 5,
            expected_fingerprint: std::env::var("FINESHELL_LIVE_FINGERPRINT").ok(),
            proxy: None,
            jump_host: None,
        };
        let (session, _) = connect_authenticated_session(&config, &AtomicBool::new(false))?;
        let available = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("查找动态转发测试端口失败：{error}"))?;
        let bind_port = available
            .local_addr()
            .map_err(|error| format!("读取动态转发测试端口失败：{error}"))?
            .port();
        drop(available);
        let (forward, _) = start_dynamic_forward(DynamicPortForwardRule {
            id: "live-dynamic-forward".to_string(),
            name: "SOCKS5 SSH banner".to_string(),
            bind_address: "127.0.0.1".to_string(),
            bind_port,
            enabled: true,
        })?;
        let listener_endpoint = forward
            .listener
            .local_addr()
            .map_err(|error| format!("读取动态转发监听地址失败：{error}"))?;
        let target_address = address.clone();
        let (client_sender, client_receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| -> Result<Vec<u8>, String> {
                let mut socket = TcpStream::connect(listener_endpoint)
                    .map_err(|error| format!("连接 SOCKS5 测试监听失败：{error}"))?;
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .map_err(|error| format!("设置 SOCKS5 测试读取超时失败：{error}"))?;
                socket
                    .write_all(&[5, 1, 0])
                    .map_err(|error| format!("发送 SOCKS5 协商请求失败：{error}"))?;
                let mut greeting = [0_u8; 2];
                socket
                    .read_exact(&mut greeting)
                    .map_err(|error| format!("读取 SOCKS5 协商响应失败：{error}"))?;
                if greeting != [5, 0] {
                    return Err(format!("SOCKS5 协商响应无效：{greeting:?}"));
                }

                let target = target_address.as_bytes();
                if target.len() > u8::MAX as usize {
                    return Err("SOCKS5 测试目标地址过长".to_string());
                }
                let mut request = vec![5, 1, 0, 3, target.len() as u8];
                request.extend_from_slice(target);
                request.extend_from_slice(&port.to_be_bytes());
                socket
                    .write_all(&request)
                    .map_err(|error| format!("发送 SOCKS5 CONNECT 请求失败：{error}"))?;
                let mut response = [0_u8; 10];
                socket
                    .read_exact(&mut response)
                    .map_err(|error| format!("读取 SOCKS5 CONNECT 响应失败：{error}"))?;
                if response[0] != 5 || response[1] != 0 {
                    return Err(format!("SOCKS5 CONNECT 被拒绝：{response:?}"));
                }

                let mut banner = Vec::new();
                let mut buffer = [0_u8; 256];
                loop {
                    let size = socket
                        .read(&mut buffer)
                        .map_err(|error| format!("读取动态转发后的 SSH 标识失败：{error}"))?;
                    if size == 0 {
                        break;
                    }
                    banner.extend_from_slice(&buffer[..size]);
                    if banner.starts_with(b"SSH-") && banner.contains(&b'\n') {
                        return Ok(banner);
                    }
                }
                Err(format!(
                    "未收到有效的 SSH 服务标识：{}",
                    String::from_utf8_lossy(&banner)
                ))
            })();
            let _ = client_sender.send(result);
        });

        let deadline = Instant::now() + Duration::from_secs(12);
        let (request_sender, request_receiver) = mpsc::channel::<DynamicConnectRequest>();
        let (result_sender, result_receiver) = mpsc::channel::<DynamicConnectionResult>();
        let mut relay = None;
        while Instant::now() < deadline {
            match forward.listener.accept() {
                Ok((socket, peer)) => dynamic_forward::spawn_socks5_handshake(
                    forward.rule.id.clone(),
                    socket,
                    peer,
                    request_sender.clone(),
                    result_sender.clone(),
                )?,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("接受动态转发连接失败：{error}")),
            }
            while let Ok(request) = request_receiver.try_recv() {
                let channel = open_dynamic_forward_channel(
                    &session,
                    &request.target_address,
                    request.target_port,
                    request.peer,
                );
                let _ = request.response.send(channel);
            }
            while let Ok(result) = result_receiver.try_recv() {
                let (socket, channel) = result.result?;
                relay = Some(ForwardConnection::new(
                    result.rule_id,
                    PortForwardKind::Dynamic,
                    socket,
                    channel,
                )?);
            }
            if let Some(relay) = relay.as_mut() {
                let _ = relay.poll()?;
            }
            if let Ok(result) = client_receiver.try_recv() {
                let banner = result?;
                if banner.starts_with(b"SSH-") {
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        Err("动态 SOCKS5 转发在线验收超时".to_string())
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_* environment variables and a stored password"]
    fn forwards_a_live_remote_listener_to_a_local_target() -> Result<(), String> {
        let host_id = std::env::var("FINESHELL_LIVE_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_HOST_ID".to_string())?;
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let remote_port = std::env::var("FINESHELL_LIVE_REMOTE_FORWARD_PORT")
            .unwrap_or_else(|_| "49123".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_REMOTE_FORWARD_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
        let config = SshAuthConfig {
            host_id,
            address,
            port,
            username,
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 5,
            expected_fingerprint: std::env::var("FINESHELL_LIVE_FINGERPRINT").ok(),
            proxy: None,
            jump_host: None,
        };
        let (session, _) = connect_authenticated_session(&config, &AtomicBool::new(false))?;

        let local_target = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("创建本地测试服务失败：{error}"))?;
        let local_target_port = local_target
            .local_addr()
            .map_err(|error| format!("读取本地测试服务端口失败：{error}"))?
            .port();
        local_target
            .set_nonblocking(true)
            .map_err(|error| format!("设置本地测试服务非阻塞模式失败：{error}"))?;
        let target_worker = std::thread::spawn(move || -> Result<(), String> {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match local_target.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .write_all(b"fineshell-remote-forward-ok")
                            .map_err(|error| format!("写入本地测试响应失败：{error}"))?;
                        return Ok(());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return Err("等待远程转发连接本地目标超时".to_string());
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => return Err(format!("接受远程转发连接失败：{error}")),
                }
            }
        });

        let (mut forward, _) = start_remote_forward(
            &session,
            RemotePortForwardRule {
                id: "live-remote-forward".to_string(),
                name: "Remote preview".to_string(),
                bind_address: "127.0.0.1".to_string(),
                bind_port: remote_port,
                target_address: "127.0.0.1".to_string(),
                target_port: local_target_port,
                enabled: true,
            },
        )?;
        let mut command = session
            .channel_session()
            .map_err(|error| format!("创建远程转发测试命令通道失败：{error}"))?;
        command
            .exec(&format!(
                "/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{remote_port}; head -c 27 <&3'"
            ))
            .map_err(|error| format!("触发远程转发连接失败：{error}"))?;
        session.set_blocking(false);

        let deadline = Instant::now() + Duration::from_secs(10);
        let remote_channel = loop {
            match forward.listener.accept() {
                Ok(channel) => break channel,
                Err(error) => {
                    let message = error.to_string();
                    let io_error: std::io::Error = error.into();
                    if io_error.kind() != std::io::ErrorKind::WouldBlock {
                        return Err(format!("接受远程监听连接失败：{message}"));
                    }
                    if Instant::now() >= deadline {
                        return Err("等待远程监听连接超时".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        };
        let target_socket = TcpStream::connect(("127.0.0.1", local_target_port))
            .map_err(|error| format!("连接本地测试目标失败：{error}"))?;
        let mut relay = ForwardConnection::new(
            "live-remote-forward".to_string(),
            PortForwardKind::Remote,
            target_socket,
            remote_channel,
        )?;
        let mut output = Vec::new();
        let mut buffer = [0_u8; 256];
        while Instant::now() < deadline {
            let _ = relay.poll()?;
            match command.read(&mut buffer) {
                Ok(0) => {}
                Ok(size) => {
                    output.extend_from_slice(&buffer[..size]);
                    if output == b"fineshell-remote-forward-ok" {
                        target_worker
                            .join()
                            .map_err(|_| "本地测试服务线程异常结束".to_string())??;
                        return Ok(());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("读取远程转发测试结果失败：{error}")),
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        Err(format!(
            "未收到有效的远程转发响应：{}",
            String::from_utf8_lossy(&output)
        ))
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_JUMP_* environment variables and stored passwords"]
    fn connects_terminal_and_sftp_through_a_live_jump_host() -> Result<(), String> {
        let jump_host_id = std::env::var("FINESHELL_LIVE_JUMP_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_JUMP_HOST_ID".to_string())?;
        let target_host_id = std::env::var("FINESHELL_LIVE_JUMP_TARGET_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_JUMP_TARGET_HOST_ID".to_string())?;
        let address = std::env::var("FINESHELL_LIVE_JUMP_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_JUMP_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_JUMP_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_JUMP_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_JUMP_USERNAME").unwrap_or_else(|_| "root".to_string());
        let fingerprint = std::env::var("FINESHELL_LIVE_JUMP_FINGERPRINT")
            .map_err(|_| "缺少 FINESHELL_LIVE_JUMP_FINGERPRINT".to_string())?;
        let target_address = std::env::var("FINESHELL_LIVE_JUMP_TARGET_ADDRESS")
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        let config = SshAuthConfig {
            host_id: target_host_id,
            address: target_address,
            port,
            username: username.clone(),
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 5,
            expected_fingerprint: Some(fingerprint.clone()),
            proxy: None,
            jump_host: Some(JumpHostConfig {
                host_id: jump_host_id,
                address,
                port,
                username,
                auth_method: SshAuthMethod::Password,
                private_key_path: None,
                connect_timeout_seconds: 10,
                keep_alive_interval_seconds: 5,
                expected_fingerprint: Some(fingerprint),
                proxy: None,
            }),
        };
        let (session, _) = connect_authenticated_session(&config, &AtomicBool::new(false))?;

        let sftp = session
            .sftp()
            .map_err(|error| format!("跳板机 SFTP 初始化失败：{error}"))?;
        sftp.realpath(std::path::Path::new("."))
            .map_err(|error| format!("跳板机 SFTP 目录读取失败：{error}"))?;
        drop(sftp);

        let mut channel = session
            .channel_session()
            .map_err(|error| format!("跳板机命令通道创建失败：{error}"))?;
        channel
            .exec("printf fineshell-jump-ok")
            .map_err(|error| format!("跳板机命令执行失败：{error}"))?;
        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(|error| format!("跳板机命令输出读取失败：{error}"))?;
        if output != "fineshell-jump-ok" {
            return Err(format!("跳板机命令输出无效：{output}"));
        }
        Ok(())
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
            proxy: None,
            jump_host: None,
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
            proxy: None,
            jump_host: None,
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
