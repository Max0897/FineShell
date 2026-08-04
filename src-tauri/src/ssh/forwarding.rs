use super::*;

pub(super) fn validate_local_forward_rule(
    rule: &LocalPortForwardRule,
) -> Result<SocketAddr, String> {
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

pub(super) fn start_local_forward(
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

pub(super) fn prepare_local_forwards(
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

pub(super) fn validate_remote_forward_rule(rule: &RemotePortForwardRule) -> Result<(), String> {
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

pub(super) fn start_remote_forward(
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

pub(super) fn prepare_remote_forwards(
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

pub(super) fn validate_dynamic_forward_rule(
    rule: &DynamicPortForwardRule,
) -> Result<SocketAddr, String> {
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

pub(super) fn start_dynamic_forward(
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

pub(super) fn prepare_dynamic_forwards(
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

pub(super) fn open_local_forward_connection(
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

pub(super) fn open_dynamic_forward_channel(
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
    pub(super) fn new(
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

    pub(super) fn poll(&mut self) -> Result<(bool, bool), String> {
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

pub(super) fn write_pending(
    channel: &mut Channel,
    pending: &mut VecDeque<Vec<u8>>,
) -> Result<bool, String> {
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

pub(super) fn read_output<R: Read>(
    reader: &mut R,
    app: &AppHandle,
    session_id: &str,
) -> Result<bool, String> {
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

pub(super) fn disconnect_status(
    closing: bool,
    terminal_error: Option<String>,
) -> (Option<String>, bool) {
    let recoverable = !closing && terminal_error.is_some();
    let error = if !closing && terminal_error.is_none() {
        Some("远程 Shell 已结束".to_string())
    } else {
        terminal_error
    };
    (error, recoverable)
}
