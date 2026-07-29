use serde::Serialize;

pub(crate) const PROTOCOL_VERSION: u16 = 19;

pub(crate) const SSH_OUTPUT_EVENT: &str = "ssh-output";
pub(crate) const SSH_STATUS_EVENT: &str = "ssh-status";
pub(crate) const PORT_FORWARD_STATUS_EVENT: &str = "port-forward-status";
pub(crate) const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
pub(crate) const EXTERNAL_EDIT_EVENT: &str = "sftp-external-edit";
pub(crate) const AI_STREAM_EVENT: &str = "ai-stream";
pub(crate) const AI_COMPLETE_EVENT: &str = "ai-complete";
pub(crate) const AGENT_TASK_EVENT: &str = "ai-task";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MENU_SELECT_ALL_EVENT: &str = "menu-select-all";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandErrorCode {
    InvalidRequest,
    NotFound,
    NotConnected,
    PermissionDenied,
    AuthenticationFailed,
    HostKeyVerificationFailed,
    ConnectionFailed,
    Timeout,
    Cancelled,
    Conflict,
    Io,
    Unsupported,
    Internal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: CommandErrorCode,
    message: String,
    retryable: bool,
    operation: &'static str,
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

impl CommandError {
    pub(crate) fn from_message(operation: &'static str, message: impl Into<String>) -> Self {
        let message = message.into();
        let normalized = message.to_lowercase();
        let (code, retryable) = if contains_any(&normalized, &["取消", "cancel"]) {
            (CommandErrorCode::Cancelled, false)
        } else if contains_any(&normalized, &["超时", "timed out", "timeout"]) {
            (CommandErrorCode::Timeout, true)
        } else if contains_any(&normalized, &["权限", "permission denied", "access denied"]) {
            (CommandErrorCode::PermissionDenied, false)
        } else if contains_any(&normalized, &["指纹", "host key"]) {
            (CommandErrorCode::HostKeyVerificationFailed, false)
        } else if contains_any(
            &normalized,
            &["认证", "密码", "口令", "authentication", "no identities"],
        ) {
            (CommandErrorCode::AuthenticationFailed, false)
        } else if contains_any(
            &normalized,
            &["未连接", "不存在会话", "not connected", "session not found"],
        ) {
            (CommandErrorCode::NotConnected, true)
        } else if contains_any(
            &normalized,
            &["不存在", "未找到", "not found", "no such file"],
        ) {
            (CommandErrorCode::NotFound, false)
        } else if contains_any(&normalized, &["冲突", "已被其他程序修改", "conflict"]) {
            (CommandErrorCode::Conflict, false)
        } else if contains_any(&normalized, &["不支持", "unsupported"]) {
            (CommandErrorCode::Unsupported, false)
        } else if contains_any(
            &normalized,
            &["不能为空", "无效", "invalid", "超过 5 mb 限制"],
        ) {
            (CommandErrorCode::InvalidRequest, false)
        } else if contains_any(
            &normalized,
            &[
                "连接失败",
                "connection failed",
                "connection refused",
                "无法连接",
            ],
        ) {
            (CommandErrorCode::ConnectionFailed, true)
        } else if contains_any(
            &normalized,
            &["无法读取", "无法写入", "无法创建", "i/o", "os error"],
        ) {
            (CommandErrorCode::Io, false)
        } else {
            (CommandErrorCode::Internal, false)
        };
        Self {
            code,
            message,
            retryable,
            operation,
        }
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[derive(Serialize)]
pub(crate) struct ProtocolVersionResult {
    version: u16,
}

#[tauri::command]
pub(crate) fn protocol_version() -> ProtocolVersionResult {
    ProtocolVersionResult {
        version: PROTOCOL_VERSION,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{
        protocol_version, CommandError, CommandErrorCode, AGENT_TASK_EVENT, AI_COMPLETE_EVENT,
        AI_STREAM_EVENT, EXTERNAL_EDIT_EVENT, MENU_SELECT_ALL_EVENT, PORT_FORWARD_STATUS_EVENT,
        PROTOCOL_VERSION, SFTP_TRANSFER_EVENT, SSH_OUTPUT_EVENT, SSH_STATUS_EVENT,
    };

    #[test]
    fn shared_contract_matches_rust_protocol() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../protocol/contract.json")).unwrap();
        assert_eq!(contract["version"].as_u64(), Some(PROTOCOL_VERSION.into()));

        let registered_commands = include_str!("lib.rs")
            .split("tauri::generate_handler![")
            .nth(1)
            .and_then(|value| value.split("])").next())
            .unwrap()
            .lines()
            .filter_map(|line| {
                let command = line.trim().trim_end_matches(',');
                (!command.is_empty() && !command.starts_with("#["))
                    .then(|| command.rsplit("::").next().unwrap().to_string())
            })
            .collect::<BTreeSet<_>>();
        let contract_commands = contract["commands"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(registered_commands, contract_commands);

        let events = contract["events"].as_object().unwrap();
        for event in [
            SSH_OUTPUT_EVENT,
            SSH_STATUS_EVENT,
            PORT_FORWARD_STATUS_EVENT,
            SFTP_TRANSFER_EVENT,
            EXTERNAL_EDIT_EVENT,
            AI_STREAM_EVENT,
            AI_COMPLETE_EVENT,
            AGENT_TASK_EVENT,
            "configuration:changed",
            "settings:changed",
            MENU_SELECT_ALL_EVENT,
        ] {
            assert_eq!(
                events.get(event).and_then(|value| value.as_bool()),
                Some(true)
            );
        }

        let serialized_error_codes = [
            CommandErrorCode::InvalidRequest,
            CommandErrorCode::NotFound,
            CommandErrorCode::NotConnected,
            CommandErrorCode::PermissionDenied,
            CommandErrorCode::AuthenticationFailed,
            CommandErrorCode::HostKeyVerificationFailed,
            CommandErrorCode::ConnectionFailed,
            CommandErrorCode::Timeout,
            CommandErrorCode::Cancelled,
            CommandErrorCode::Conflict,
            CommandErrorCode::Io,
            CommandErrorCode::Unsupported,
            CommandErrorCode::Internal,
        ]
        .into_iter()
        .map(|code| {
            serde_json::to_value(code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<BTreeSet<_>>();
        let contract_error_codes = contract["errorCodes"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(serialized_error_codes, contract_error_codes);
        assert_eq!(protocol_version().version, PROTOCOL_VERSION);
    }

    #[test]
    fn classifies_command_errors_at_the_protocol_boundary() {
        let permission = CommandError::from_message("read_config_file", "Permission denied");
        assert!(matches!(
            permission.code,
            CommandErrorCode::PermissionDenied
        ));
        assert!(!permission.retryable);

        let timeout = CommandError::from_message("ssh_connect", "连接超时");
        assert!(matches!(timeout.code, CommandErrorCode::Timeout));
        assert!(timeout.retryable);
    }
}
