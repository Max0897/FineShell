use std::io::Read;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ssh2::Session;

const MAX_SERVICE_NAME_CHARS: usize = 128;
const MAX_CONFIG_PATH_CHARS: usize = 1_024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentPortProtocol {
    Tcp,
    Udp,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentConfigValidator {
    Nginx,
    Apache,
    Caddy,
    Sshd,
    Haproxy,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "kind")]
pub(crate) enum AgentBusinessVerification {
    ServiceActive {
        service: String,
    },
    ServiceInactive {
        service: String,
    },
    PortListening {
        port: u16,
        protocol: AgentPortProtocol,
    },
    ConfigSyntax {
        validator: AgentConfigValidator,
        path: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AgentBusinessVerificationKind {
    ServiceStatus,
    PortListening,
    ConfigSyntax,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentBusinessVerificationResult {
    pub(crate) passed: bool,
    pub(crate) summary: String,
}

impl AgentBusinessVerification {
    pub(crate) fn from_value(value: Value) -> Result<Self, String> {
        let verification: Self = serde_json::from_value(value)
            .map_err(|_| "AI 业务验证参数不在后端注册表中".to_string())?;
        verification.validate()?;
        Ok(verification)
    }

    pub(crate) fn normalized_value(value: Value) -> Result<Value, String> {
        serde_json::to_value(Self::from_value(value)?)
            .map_err(|_| "AI 业务验证参数无法规范化".to_string())
    }

    pub(crate) fn kind(&self) -> AgentBusinessVerificationKind {
        match self {
            Self::ServiceActive { .. } | Self::ServiceInactive { .. } => {
                AgentBusinessVerificationKind::ServiceStatus
            }
            Self::PortListening { .. } => AgentBusinessVerificationKind::PortListening,
            Self::ConfigSyntax { .. } => AgentBusinessVerificationKind::ConfigSyntax,
        }
    }

    fn validate(&self) -> Result<(), String> {
        match self {
            Self::ServiceActive { service } | Self::ServiceInactive { service } => {
                if service.is_empty()
                    || service.chars().count() > MAX_SERVICE_NAME_CHARS
                    || service.starts_with('-')
                    || !service.chars().all(|character| {
                        character.is_ascii_alphanumeric()
                            || matches!(character, '.' | '_' | '@' | ':' | '-')
                    })
                {
                    return Err("AI 服务状态验证名称无效".to_string());
                }
            }
            Self::PortListening { port, .. } if *port == 0 => {
                return Err("AI 端口验证范围无效".to_string());
            }
            Self::PortListening { .. } => {}
            Self::ConfigSyntax { path, .. } => {
                if let Some(path) = path {
                    validate_remote_path(path)?;
                }
            }
        }
        Ok(())
    }

    fn command(&self) -> String {
        const PATH_SETUP: &str =
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; ";
        match self {
            Self::ServiceActive { service } => format!(
                "{PATH_SETUP}if command -v systemctl >/dev/null 2>&1; then systemctl is-active --quiet -- {service}; elif command -v service >/dev/null 2>&1; then service {service} status >/dev/null 2>&1; else exit 127; fi"
            ),
            Self::ServiceInactive { service } => format!(
                "{PATH_SETUP}if command -v systemctl >/dev/null 2>&1; then ! systemctl is-active --quiet -- {service}; elif command -v service >/dev/null 2>&1; then ! service {service} status >/dev/null 2>&1; else exit 127; fi"
            ),
            Self::PortListening { port, protocol } => {
                let flag = match protocol {
                    AgentPortProtocol::Tcp => "-ltn",
                    AgentPortProtocol::Udp => "-lun",
                };
                format!(
                    "{PATH_SETUP}command -v ss >/dev/null 2>&1 || exit 127; ss -H {flag} 2>/dev/null | awk '{{ address=$4; sub(/^.*:/, \"\", address); if (address == \"{port}\") found=1 }} END {{ exit found ? 0 : 1 }}'"
                )
            }
            Self::ConfigSyntax { validator, path } => {
                let path = path.as_deref().map(shell_quote);
                let command = match (validator, path.as_deref()) {
                    (AgentConfigValidator::Nginx, Some(path)) => format!("nginx -t -c {path}"),
                    (AgentConfigValidator::Nginx, None) => "nginx -t".to_string(),
                    (AgentConfigValidator::Apache, _) => "apachectl configtest".to_string(),
                    (AgentConfigValidator::Caddy, Some(path)) => {
                        format!("caddy validate --config {path}")
                    }
                    (AgentConfigValidator::Caddy, None) => "caddy validate".to_string(),
                    (AgentConfigValidator::Sshd, Some(path)) => format!("sshd -t -f {path}"),
                    (AgentConfigValidator::Sshd, None) => "sshd -t".to_string(),
                    (AgentConfigValidator::Haproxy, Some(path)) => {
                        format!("haproxy -c -f {path}")
                    }
                    (AgentConfigValidator::Haproxy, None) => {
                        "haproxy -c -f /etc/haproxy/haproxy.cfg".to_string()
                    }
                };
                format!("{PATH_SETUP}{command} >/dev/null 2>&1")
            }
        }
    }

    fn summary(&self, passed: bool, unavailable: bool) -> String {
        match self {
            Self::ServiceActive { service } => {
                if unavailable {
                    format!("无法在远程服务器检查服务 {service} 的状态")
                } else if passed {
                    format!("服务 {service} 处于运行状态")
                } else {
                    format!("服务 {service} 未处于运行状态")
                }
            }
            Self::ServiceInactive { service } => {
                if unavailable {
                    format!("无法在远程服务器检查服务 {service} 的状态")
                } else if passed {
                    format!("服务 {service} 已停止")
                } else {
                    format!("服务 {service} 仍处于运行状态")
                }
            }
            Self::PortListening { port, protocol } => {
                let protocol = match protocol {
                    AgentPortProtocol::Tcp => "TCP",
                    AgentPortProtocol::Udp => "UDP",
                };
                if unavailable {
                    format!("无法在远程服务器检查 {protocol} 端口 {port}")
                } else if passed {
                    format!("{protocol} 端口 {port} 正在监听")
                } else {
                    format!("{protocol} 端口 {port} 未监听")
                }
            }
            Self::ConfigSyntax { validator, .. } => {
                let validator = match validator {
                    AgentConfigValidator::Nginx => "Nginx",
                    AgentConfigValidator::Apache => "Apache",
                    AgentConfigValidator::Caddy => "Caddy",
                    AgentConfigValidator::Sshd => "sshd",
                    AgentConfigValidator::Haproxy => "HAProxy",
                };
                if unavailable {
                    format!("无法在远程服务器运行 {validator} 配置语法检查")
                } else if passed {
                    format!("{validator} 配置语法检查通过")
                } else {
                    format!("{validator} 配置语法检查未通过")
                }
            }
        }
    }
}

pub(crate) fn execute_business_verification(
    session: &Session,
    verification: &AgentBusinessVerification,
) -> Result<AgentBusinessVerificationResult, String> {
    session.set_blocking(true);
    let result = (|| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建 AI 验证通道：{error}"))?;
        channel
            .exec(&verification.command())
            .map_err(|error| format!("无法执行 AI 验证命令：{error}"))?;
        let mut sink = Vec::new();
        (&mut channel)
            .take(8 * 1024)
            .read_to_end(&mut sink)
            .map_err(|error| format!("无法读取 AI 验证结果：{error}"))?;
        channel
            .wait_close()
            .map_err(|error| format!("AI 验证通道关闭失败：{error}"))?;
        let exit_status = channel
            .exit_status()
            .map_err(|error| format!("无法读取 AI 验证状态：{error}"))?;
        Ok(AgentBusinessVerificationResult {
            passed: exit_status == 0,
            summary: verification.summary(exit_status == 0, exit_status == 127),
        })
    })();
    session.set_blocking(false);
    result
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.chars().count() > MAX_CONFIG_PATH_CHARS
        || path.chars().any(char::is_control)
        || path.split('/').any(|segment| matches!(segment, "." | ".."))
    {
        return Err("AI 配置语法验证路径无效".to_string());
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AgentBusinessVerification, AgentConfigValidator, AgentPortProtocol};

    #[test]
    fn normalizes_registered_business_verifiers() {
        let service = AgentBusinessVerification::from_value(json!({
            "kind": "service_active",
            "service": "nginx.service",
        }))
        .unwrap();
        assert!(service.command().contains("systemctl is-active"));

        let stopped_service = AgentBusinessVerification::from_value(json!({
            "kind": "service_inactive",
            "service": "nginx.service",
        }))
        .unwrap();
        assert_eq!(
            stopped_service,
            AgentBusinessVerification::ServiceInactive {
                service: "nginx.service".to_string(),
            }
        );
        assert!(stopped_service.command().contains("! systemctl is-active"));

        let port = AgentBusinessVerification::from_value(json!({
            "kind": "port_listening",
            "port": 443,
            "protocol": "tcp",
        }))
        .unwrap();
        assert_eq!(
            port,
            AgentBusinessVerification::PortListening {
                port: 443,
                protocol: AgentPortProtocol::Tcp,
            }
        );

        let config = AgentBusinessVerification::from_value(json!({
            "kind": "config_syntax",
            "validator": "nginx",
            "path": "/etc/nginx/nginx.conf",
        }))
        .unwrap();
        assert_eq!(
            config,
            AgentBusinessVerification::ConfigSyntax {
                validator: AgentConfigValidator::Nginx,
                path: Some("/etc/nginx/nginx.conf".to_string()),
            }
        );
        assert!(config.command().contains("nginx -t -c"));
    }

    #[test]
    fn rejects_unregistered_or_unsafe_verification_arguments() {
        for value in [
            json!({ "kind": "service_active", "service": "nginx; reboot" }),
            json!({ "kind": "port_listening", "port": 0, "protocol": "tcp" }),
            json!({ "kind": "config_syntax", "validator": "shell", "path": "/tmp/a" }),
            json!({ "kind": "config_syntax", "validator": "nginx", "path": "/etc/../root" }),
        ] {
            assert!(AgentBusinessVerification::from_value(value).is_err());
        }
    }
}
