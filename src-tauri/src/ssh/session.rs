use super::*;

pub(super) fn run_session(
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
                Ok(SessionCommand::AgentVerify {
                    verification,
                    response,
                }) => {
                    let _ = response.send(execute_business_verification(&session, &verification));
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

pub(super) fn connect_session(
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
