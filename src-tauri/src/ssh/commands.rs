use super::*;
use tauri::State;

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
    manager.write(&session_id, data)
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
    manager.monitor_snapshot(&session_id).await
}

#[tauri::command]
pub(crate) async fn ssh_ping(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    target: String,
) -> Result<NetworkPingResult, String> {
    manager.ping(&session_id, target).await
}

#[tauri::command]
pub(crate) async fn ssh_network_connections(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<NetworkConnectionsResult, String> {
    manager.network_connections(&session_id).await
}

#[tauri::command]
pub(crate) async fn ssh_trace_route(
    manager: State<'_, SshSessionManager>,
    session_id: String,
    target: String,
) -> Result<NetworkTraceResult, String> {
    manager.trace_route(&session_id, target).await
}

#[tauri::command]
pub(crate) async fn ssh_processes(
    manager: State<'_, SshSessionManager>,
    session_id: String,
) -> Result<ServerProcessListResult, String> {
    manager.processes(&session_id).await
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
