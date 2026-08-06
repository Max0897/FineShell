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
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::{
    emit_task_events, AgentCommandExecutionPhase, AgentCommandOutputSnapshot, AgentTaskManager,
};
use crate::agent_verification::{
    execute_business_verification, AgentBusinessVerification, AgentBusinessVerificationResult,
};
use crate::credentials;
use crate::dynamic_forward::{self, DynamicConnectRequest, DynamicConnectionResult};
use crate::monitor::{
    self, NetworkConnectionsResult, NetworkPingResult, NetworkTraceResult, ServerMonitorSnapshot,
    ServerProcessListResult,
};
use crate::protocol::{PORT_FORWARD_STATUS_EVENT, SSH_OUTPUT_EVENT, SSH_STATUS_EVENT};
use crate::transport::{self, ProxyConfig};

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

#[derive(Clone)]
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
    AgentVerify {
        verification: AgentBusinessVerification,
        response: SyncSender<Result<AgentBusinessVerificationResult, String>>,
    },
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

mod agent;
mod auth;
mod events;
mod forwarding;
mod health;
mod manager;
mod session;

use agent::*;
pub(crate) use agent::{AgentCommandExecutionContext, AgentCommandExecutionResult};
pub(crate) use auth::connect_authenticated_session;
use auth::*;
use events::*;
use forwarding::*;
pub(crate) use manager::SshSessionManager;
use session::*;

mod commands;

pub(crate) use commands::*;

#[cfg(test)]
mod tests;
