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
    connect_authenticated_session, connect_handshaken_session, disconnect_status, loopback_pair,
    open_dynamic_forward_channel, open_local_forward_connection, start_dynamic_forward,
    start_local_forward, start_remote_forward, validate_dynamic_forward_rule, validate_fingerprint,
    validate_remote_forward_rule, verify_fingerprint, DynamicPortForwardRule,
    FingerprintVerification, ForwardConnection, JumpHostConfig, LocalPortForwardRule,
    PortForwardKind, RemotePortForwardRule, SessionCommand, SshAuthConfig, SshAuthMethod,
    SshSessionManager,
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
    let username = std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
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
    let username = std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
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
    let username = std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
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
fn reports_connection_state_and_removes_stopped_sessions() {
    let manager = SshSessionManager::default();
    assert!(!manager.is_connected("session-1").unwrap());

    manager.begin_connect("session-1").unwrap();
    assert!(!manager.is_connected("session-1").unwrap());
    let (sender, receiver) = std::sync::mpsc::channel();
    manager.activate("session-1", sender).unwrap();
    assert!(manager.is_connected("session-1").unwrap());

    drop(receiver);
    assert_eq!(
        manager
            .send("session-1", SessionCommand::Write(vec![1]))
            .unwrap_err(),
        "SSH 会话已停止"
    );
    assert!(!manager.is_connected("session-1").unwrap());
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
    let username = std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
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

    let (session, fingerprint) = connect_authenticated_session(&config, &AtomicBool::new(false))?;
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
        username: std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string()),
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
