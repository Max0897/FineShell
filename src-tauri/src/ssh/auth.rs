use super::*;

pub(super) fn host_fingerprint(session: &Session) -> Result<String, String> {
    let hash = session
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| "服务器没有提供可校验的主机指纹".to_string())?;
    Ok(format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
}

pub(super) fn verify_fingerprint(expected: Option<&str>, actual: &str) -> FingerprintVerification {
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

pub(super) fn validate_fingerprint(expected: Option<&str>, actual: &str) -> Result<(), String> {
    match verify_fingerprint(expected, actual) {
        FingerprintVerification::Trusted | FingerprintVerification::Unknown => Ok(()),
        FingerprintVerification::Changed(expected) => {
            Err(format!("主机指纹不匹配，期望 {expected}，实际 {actual}"))
        }
    }
}

pub(super) fn resolve_private_key_path(path: &str) -> Result<PathBuf, String> {
    if let Some(path) = crate::managed_keys::resolve_reference(path)? {
        return Ok(path);
    }
    let Some(relative) = path.strip_prefix("~/") else {
        return Ok(PathBuf::from(path));
    };
    Ok(std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(relative))
        .unwrap_or_else(|| PathBuf::from(path)))
}

pub(super) fn configure_keepalive(session: &Session, interval_seconds: u32) {
    if interval_seconds > 0 {
        session.set_keepalive(true, interval_seconds.clamp(5, 300));
    }
}

pub(super) fn write_relay_pending<W: Write>(
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

pub(super) fn run_jump_relay(
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

pub(super) fn loopback_pair() -> Result<(TcpStream, TcpStream), String> {
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

pub(super) fn connect_via_jump_host(
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

pub(super) fn connect_handshaken_session(
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

pub(super) fn authenticate_session(
    session: &Session,
    config: &SshAuthConfig,
) -> Result<(), String> {
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
            let private_key = resolve_private_key_path(private_key_path)?;
            if !private_key.is_file() {
                if private_key_path.starts_with("managed://") {
                    return Err("托管 SSH 私钥不存在，请在设置中重新添加密钥".to_string());
                }
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
