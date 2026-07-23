use std::{
    io::{Read, Write},
    net::{Ipv6Addr, TcpStream, ToSocketAddrs},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use tokio::runtime::Builder;
use tokio_socks::tcp::Socks5Stream;

use crate::credentials;

const MAX_HTTP_PROXY_RESPONSE_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProxyType {
    Socks5,
    Http,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyConfig {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) proxy_type: ProxyType,
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) username: Option<String>,
}

fn connect_endpoint(
    address: &str,
    port: u16,
    timeout: Duration,
    endpoint_name: &str,
) -> Result<TcpStream, String> {
    let addresses = (address, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析{endpoint_name}地址：{error}"))?;
    let mut last_error = None;

    for endpoint in addresses {
        match TcpStream::connect_timeout(&endpoint, timeout) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error
        .map(|error| format!("无法连接到{endpoint_name}：{error}"))
        .unwrap_or_else(|| format!("{endpoint_name}地址没有可用的网络端点")))
}

fn target_authority(address: &str, port: u16) -> Result<String, String> {
    if address.is_empty() || address.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("目标主机地址无效".to_string());
    }
    if address.parse::<Ipv6Addr>().is_ok() {
        Ok(format!("[{address}]:{port}"))
    } else {
        Ok(format!("{address}:{port}"))
    }
}

fn read_http_proxy_status(stream: &mut TcpStream) -> Result<u16, String> {
    let mut response_bytes = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while response_bytes.len() < MAX_HTTP_PROXY_RESPONSE_BYTES {
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("读取 HTTP 代理响应失败：{error}"))?;
        response_bytes.push(byte[0]);
        if response_bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !response_bytes.ends_with(b"\r\n\r\n") {
        return Err("HTTP 代理响应头过大或不完整".to_string());
    }

    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut response = httparse::Response::new(&mut headers);
    match response
        .parse(&response_bytes)
        .map_err(|error| format!("HTTP 代理响应格式无效：{error}"))?
    {
        httparse::Status::Complete(_) => response
            .code
            .ok_or_else(|| "HTTP 代理没有返回状态码".to_string()),
        httparse::Status::Partial => Err("HTTP 代理响应不完整".to_string()),
    }
}

fn connect_http_proxy(
    target_address: &str,
    target_port: u16,
    proxy: &ProxyConfig,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let mut stream = connect_endpoint(&proxy.address, proxy.port, timeout, "HTTP 代理")?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("设置 HTTP 代理读取超时失败：{error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("设置 HTTP 代理写入超时失败：{error}"))?;

    let authority = target_authority(target_address, target_port)?;
    let authorization = match proxy.username.as_deref().map(str::trim) {
        Some(username) if !username.is_empty() => {
            if username.bytes().any(|byte| byte.is_ascii_control()) {
                return Err("HTTP 代理用户名无效".to_string());
            }
            let password = credentials::get_proxy_password(&proxy.id)?;
            Some(STANDARD.encode(format!("{username}:{password}")))
        }
        _ => None,
    };
    let mut request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n"
    );
    if let Some(authorization) = authorization {
        request.push_str(&format!("Proxy-Authorization: Basic {authorization}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送 HTTP CONNECT 请求失败：{error}"))?;

    match read_http_proxy_status(&mut stream)? {
        200..=299 => {}
        407 => return Err("HTTP 代理认证失败".to_string()),
        status => return Err(format!("HTTP 代理拒绝连接，状态码 {status}")),
    }
    stream
        .set_read_timeout(None)
        .map_err(|error| format!("恢复 HTTP 代理读取设置失败：{error}"))?;
    stream
        .set_write_timeout(None)
        .map_err(|error| format!("恢复 HTTP 代理写入设置失败：{error}"))?;
    Ok(stream)
}

fn connect_socks5_proxy(
    target_address: &str,
    target_port: u16,
    proxy: &ProxyConfig,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let stream = connect_endpoint(&proxy.address, proxy.port, timeout, "SOCKS5 代理")?;
    stream
        .set_nonblocking(true)
        .map_err(|error| format!("初始化 SOCKS5 代理连接失败：{error}"))?;
    let username = proxy
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let password = username
        .as_ref()
        .map(|_| credentials::get_proxy_password(&proxy.id))
        .transpose()?;
    let runtime = Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| format!("初始化 SOCKS5 代理任务失败：{error}"))?;

    let tunnel = runtime
        .block_on(async {
            let socket = tokio::net::TcpStream::from_std(stream)?;
            tokio::time::timeout(timeout, async {
                match (username.as_deref(), password.as_deref()) {
                    (Some(username), Some(password)) => {
                        Socks5Stream::connect_with_password_and_socket(
                            socket,
                            (target_address, target_port),
                            username,
                            password,
                        )
                        .await
                    }
                    _ => {
                        Socks5Stream::connect_with_socket(socket, (target_address, target_port))
                            .await
                    }
                }
            })
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "SOCKS5 代理握手超时"))?
            .map_err(|error| std::io::Error::other(error.to_string()))
        })
        .map_err(|error| format!("SOCKS5 代理连接失败：{error}"))?;
    let stream = tunnel
        .into_inner()
        .into_std()
        .map_err(|error| format!("转换 SOCKS5 代理连接失败：{error}"))?;
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("启用 SOCKS5 阻塞连接失败：{error}"))?;
    Ok(stream)
}

pub(crate) fn connect(
    target_address: &str,
    target_port: u16,
    proxy: Option<&ProxyConfig>,
    timeout_seconds: u64,
) -> Result<TcpStream, String> {
    let timeout = Duration::from_secs(timeout_seconds.clamp(3, 120));
    match proxy {
        None => connect_endpoint(target_address, target_port, timeout, "主机"),
        Some(proxy) => match proxy.proxy_type {
            ProxyType::Socks5 => connect_socks5_proxy(target_address, target_port, proxy, timeout),
            ProxyType::Http => connect_http_proxy(target_address, target_port, proxy, timeout),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    use super::{connect, connect_http_proxy, connect_socks5_proxy, ProxyConfig, ProxyType};

    fn proxy(id: &str, proxy_type: ProxyType, address: String, port: u16) -> ProxyConfig {
        ProxyConfig {
            id: id.to_string(),
            proxy_type,
            address,
            port,
            username: None,
        }
    }

    #[test]
    fn establishes_an_http_connect_tunnel_without_overreading() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT server.example.com:22 HTTP/1.1\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
        });

        let stream = connect_http_proxy(
            "server.example.com",
            22,
            &proxy(
                "http",
                ProxyType::Http,
                endpoint.ip().to_string(),
                endpoint.port(),
            ),
            Duration::from_secs(2),
        )
        .unwrap();
        drop(stream);
        worker.join().unwrap();
    }

    #[test]
    fn establishes_a_socks5_tunnel_with_remote_dns() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut greeting = [0_u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 1, 0]);
            stream.write_all(&[5, 0]).unwrap();

            let mut request = [0_u8; 5];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request[..4], &[5, 1, 0, 3]);
            let domain_len = request[4] as usize;
            let mut target = vec![0_u8; domain_len + 2];
            stream.read_exact(&mut target).unwrap();
            assert_eq!(&target[..domain_len], b"server.example.com");
            assert_eq!(&target[domain_len..], &22_u16.to_be_bytes());
            stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).unwrap();
        });

        let stream = connect_socks5_proxy(
            "server.example.com",
            22,
            &proxy(
                "socks5",
                ProxyType::Socks5,
                endpoint.ip().to_string(),
                endpoint.port(),
            ),
            Duration::from_secs(2),
        )
        .unwrap();
        drop(stream);
        worker.join().unwrap();
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_ADDRESS and FINESHELL_LIVE_PROXY_* settings"]
    fn handshakes_ssh_through_a_live_proxy() -> Result<(), String> {
        let proxy_type = match std::env::var("FINESHELL_LIVE_PROXY_TYPE")
            .unwrap_or_else(|_| "socks5".to_string())
            .as_str()
        {
            "http" => ProxyType::Http,
            "socks5" => ProxyType::Socks5,
            _ => return Err("FINESHELL_LIVE_PROXY_TYPE 仅支持 http 或 socks5".to_string()),
        };
        let proxy = ProxyConfig {
            id: "fineshell-live-proxy".to_string(),
            proxy_type,
            address: std::env::var("FINESHELL_LIVE_PROXY_ADDRESS")
                .map_err(|_| "缺少 FINESHELL_LIVE_PROXY_ADDRESS".to_string())?,
            port: std::env::var("FINESHELL_LIVE_PROXY_PORT")
                .map_err(|_| "缺少 FINESHELL_LIVE_PROXY_PORT".to_string())?
                .parse::<u16>()
                .map_err(|error| format!("FINESHELL_LIVE_PROXY_PORT 无效：{error}"))?,
            username: None,
        };
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let stream = connect(&address, port, Some(&proxy), 10)?;
        let mut session = ssh2::Session::new().map_err(|error| error.to_string())?;
        session.set_timeout(10_000);
        session.set_tcp_stream(stream);
        session
            .handshake()
            .map_err(|error| format!("代理 SSH 握手失败：{error}"))?;
        if session.host_key().is_none() {
            return Err("代理 SSH 握手没有返回主机密钥".to_string());
        }
        Ok(())
    }
}
