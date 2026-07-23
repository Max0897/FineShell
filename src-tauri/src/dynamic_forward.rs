use std::{
    net::{SocketAddr, TcpStream},
    sync::mpsc::{self, Sender, SyncSender},
    time::Duration,
};

use fast_socks5::{
    server::Socks5ServerProtocol, util::target_addr::TargetAddr, ReplyError, Socks5Command,
};
use ssh2::Channel;

pub(crate) struct DynamicConnectRequest {
    pub(crate) rule_id: String,
    pub(crate) target_address: String,
    pub(crate) target_port: u16,
    pub(crate) peer: SocketAddr,
    pub(crate) response: SyncSender<Result<Channel, String>>,
}

pub(crate) struct DynamicConnectionResult {
    pub(crate) rule_id: String,
    pub(crate) result: Result<(TcpStream, Channel), String>,
}

pub(crate) fn spawn_socks5_handshake(
    rule_id: String,
    socket: TcpStream,
    peer: SocketAddr,
    request_sender: Sender<DynamicConnectRequest>,
    result_sender: Sender<DynamicConnectionResult>,
) -> Result<(), String> {
    socket
        .set_nonblocking(true)
        .map_err(|error| format!("无法启用 SOCKS5 连接的非阻塞模式：{error}"))?;
    tauri::async_runtime::spawn(async move {
        let result = match tokio::net::TcpStream::from_std(socket) {
            Ok(socket) => {
                handle_socks5_handshake(rule_id.clone(), socket, peer, request_sender).await
            }
            Err(error) => Err(format!("无法接管 SOCKS5 客户端连接：{error}")),
        };
        let _ = result_sender.send(DynamicConnectionResult { rule_id, result });
    });
    Ok(())
}

async fn handle_socks5_handshake(
    rule_id: String,
    socket: tokio::net::TcpStream,
    peer: SocketAddr,
    request_sender: Sender<DynamicConnectRequest>,
) -> Result<(TcpStream, Channel), String> {
    let handshake = tokio::time::timeout(Duration::from_secs(10), async {
        Socks5ServerProtocol::accept_no_auth(socket)
            .await
            .map_err(|error| format!("SOCKS5 认证协商失败：{error}"))?
            .read_command()
            .await
            .map_err(|error| format!("SOCKS5 请求解析失败：{error}"))
    })
    .await
    .map_err(|_| "SOCKS5 握手超时".to_string())??;
    let (protocol, command, target) = handshake;
    if command != Socks5Command::TCPConnect {
        let _ = protocol.reply_error(&ReplyError::CommandNotSupported).await;
        return Err("动态端口转发仅支持 SOCKS5 CONNECT 命令".to_string());
    }

    let (target_address, target_port) = match target {
        TargetAddr::Ip(address) => (address.ip().to_string(), address.port()),
        TargetAddr::Domain(domain, port) => (domain, port),
    };
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    request_sender
        .send(DynamicConnectRequest {
            rule_id,
            target_address,
            target_port,
            peer,
            response: response_sender,
        })
        .map_err(|_| "SSH 会话已停止".to_string())?;
    let channel = match tauri::async_runtime::spawn_blocking(move || {
        response_receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("等待 SSH 动态转发通道失败：{error}"))?
    })
    .await
    .map_err(|error| format!("动态转发通道任务异常结束：{error}"))?
    {
        Ok(channel) => channel,
        Err(error) => {
            let _ = protocol.reply_error(&ReplyError::ConnectionRefused).await;
            return Err(error);
        }
    };
    let socket = protocol
        .reply_success(SocketAddr::from(([0, 0, 0, 0], 0)))
        .await
        .map_err(|error| format!("发送 SOCKS5 成功响应失败：{error}"))?;
    let socket = socket
        .into_std()
        .map_err(|error| format!("释放 SOCKS5 客户端连接失败：{error}"))?;
    Ok((socket, channel))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc,
        time::Duration,
    };

    use super::{spawn_socks5_handshake, DynamicConnectRequest, DynamicConnectionResult};

    #[test]
    fn parses_a_domain_connect_request_and_replies_with_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut socket = TcpStream::connect(endpoint).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket.write_all(&[5, 1, 0]).unwrap();
            let mut greeting = [0_u8; 2];
            socket.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 0]);

            let domain = b"example.com";
            let mut request = vec![5, 1, 0, 3, domain.len() as u8];
            request.extend_from_slice(domain);
            request.extend_from_slice(&443_u16.to_be_bytes());
            socket.write_all(&request).unwrap();
            let mut response = [0_u8; 10];
            socket.read_exact(&mut response).unwrap();
            assert_eq!(response[0], 5);
            assert_eq!(response[1], 5);
        });
        let (socket, peer) = listener.accept().unwrap();
        let (request_sender, request_receiver) = mpsc::channel::<DynamicConnectRequest>();
        let (result_sender, result_receiver) = mpsc::channel::<DynamicConnectionResult>();
        spawn_socks5_handshake(
            "dynamic-1".to_string(),
            socket,
            peer,
            request_sender,
            result_sender,
        )
        .unwrap();

        let request = request_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(request.rule_id, "dynamic-1");
        assert_eq!(request.target_address, "example.com");
        assert_eq!(request.target_port, 443);
        request
            .response
            .send(Err("target refused".to_string()))
            .unwrap();
        let result = result_receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(result.rule_id, "dynamic-1");
        assert!(result.result.is_err());
        client.join().unwrap();
    }
}
