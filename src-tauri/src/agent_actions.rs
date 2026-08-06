use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

use crate::agent::{AgentActionIntent, AgentActionRisk};
use crate::agent_verification::AgentBusinessVerification;

pub(crate) const MAX_FILE_EDIT_CHARS: usize = 60_000;
pub(crate) const MAX_TERMINAL_COMMAND_CHARS: usize = 4_096;
pub(crate) const MAX_COMMAND_PURPOSE_CHARS: usize = 240;
pub(crate) const MAX_COMMAND_RISK_REASON_CHARS: usize = 240;
pub(crate) const TERMINAL_EXECUTE_ACTION_TOOL: &str = "execute_terminal_command";

pub(crate) fn valid_service_name(service: &str) -> bool {
    !service.is_empty()
        && service.chars().count() <= 128
        && !service.starts_with('-')
        && service.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '@' | ':' | '-')
        })
}

fn service_action_command(
    service: &str,
    action: &str,
) -> Result<(String, String, String, AgentActionRisk, Option<Value>), String> {
    if !valid_service_name(service) {
        return Err("AI 服务名称无效".to_string());
    }
    let (command, purpose, expected_effect, risk, verification) = match action {
        "status" => (
            format!("systemctl is-active -- {service}"),
            format!("检查服务 {service} 的运行状态"),
            "只读取服务当前运行状态".to_string(),
            AgentActionRisk::LowRisk,
            None,
        ),
        "start" => (
            format!("sudo -n systemctl start -- {service}"),
            format!("启动服务 {service}"),
            "启动指定 systemd 服务并验证其运行状态".to_string(),
            AgentActionRisk::Elevated,
            Some(json!({ "kind": "service_active", "service": service })),
        ),
        "stop" => (
            format!("sudo -n systemctl stop -- {service}"),
            format!("停止服务 {service}"),
            "停止指定 systemd 服务并验证其已停止".to_string(),
            AgentActionRisk::Elevated,
            Some(json!({ "kind": "service_inactive", "service": service })),
        ),
        "restart" => (
            format!("sudo -n systemctl restart -- {service}"),
            format!("重启服务 {service}"),
            "重启指定 systemd 服务并验证其恢复运行".to_string(),
            AgentActionRisk::Elevated,
            Some(json!({ "kind": "service_active", "service": service })),
        ),
        _ => return Err("AI 服务操作类型无效".to_string()),
    };
    Ok((command, purpose, expected_effect, risk, verification))
}

fn parse_arguments(arguments: &str) -> Result<Map<String, Value>, String> {
    let Value::Object(arguments) =
        serde_json::from_str(arguments).map_err(|_| "AI 动作参数不是有效 JSON".to_string())?
    else {
        return Err("AI 动作参数必须是对象".to_string());
    };
    Ok(arguments)
}

fn exact_keys(arguments: &Map<String, Value>, keys: &[&str]) -> bool {
    arguments.len() == keys.len() && keys.iter().all(|key| arguments.contains_key(*key))
}

pub(crate) fn normalize_remote_action_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.chars().count() > 1_024 || path.chars().any(char::is_control)
    {
        return Err("AI 文件动作必须使用有效的远程绝对路径".to_string());
    }
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| matches!(*segment, "." | ".."))
    {
        return Err("AI 文件动作路径不能包含相对路径片段".to_string());
    }
    if segments.is_empty() {
        return Err("禁止对远程根目录执行 AI 文件动作".to_string());
    }
    Ok(format!("/{}", segments.join("/")))
}

fn valid_content(content: &str) -> bool {
    content.chars().count() <= MAX_FILE_EDIT_CHARS && !content.contains('\0')
}

pub(crate) fn valid_command(command: &str) -> bool {
    let command = command.trim();
    !command.is_empty()
        && command.chars().count() <= MAX_TERMINAL_COMMAND_CHARS
        && !command.chars().any(|character| {
            character == '\r' || character == '\n' || (character.is_control() && character != '\t')
        })
}

fn normalize_purpose(purpose: &str) -> Result<String, String> {
    let purpose = purpose.split_whitespace().collect::<Vec<_>>().join(" ");
    if purpose.is_empty()
        || purpose.chars().count() > MAX_COMMAND_PURPOSE_CHARS
        || purpose.chars().any(char::is_control)
    {
        return Err("AI 命令用途无效".to_string());
    }
    Ok(purpose)
}

fn normalize_risk_reason(reason: &str) -> Result<String, String> {
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    if reason.is_empty()
        || reason.chars().count() > MAX_COMMAND_RISK_REASON_CHARS
        || reason.chars().any(char::is_control)
    {
        return Err("AI 命令风险说明无效".to_string());
    }
    Ok(reason)
}

fn command_requires_confirmation(command: &str) -> bool {
    static DANGEROUS: OnceLock<Regex> = OnceLock::new();
    static MUTATING: OnceLock<Regex> = OnceLock::new();
    let dangerous = DANGEROUS.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[;&|]\s*)(?:sudo\s+)?(?:rm\b|dd\b|mkfs(?:\.[\w-]+)?\b|wipefs\b|shutdown\b|reboot\b|poweroff\b|halt\b|kill(?:all)?\b|pkill\b)|:\(\)\s*\{\s*:\|:&\s*\};:",
        )
        .expect("terminal danger expression must compile")
    });
    let mutating = MUTATING.get_or_init(|| {
        Regex::new(
            r"(?i)\bsudo\b|\b(?:chmod|chown)\s+-R\b|\bsystemctl\s+(?:start|stop|restart|disable|mask)\b|\b(?:apt|apt-get|dnf|yum|pacman|apk|brew)\s+(?:install|remove|purge|upgrade)\b|(?:curl|wget)[^\r\n|]*\|\s*(?:ba)?sh\b|(?:^|\s)>(?:>|\s*)\s*/(?:etc|usr|var)/",
        )
        .expect("terminal mutation expression must compile")
    });
    dangerous.is_match(command) || mutating.is_match(command)
}

fn terminal_action_risk(command: &str, ai_risk: &str) -> Result<AgentActionRisk, String> {
    if !matches!(ai_risk, "safe" | "caution" | "danger") {
        return Err("AI 命令风险等级无效".to_string());
    }
    Ok(
        if ai_risk == "safe" && !command_requires_confirmation(command) {
            AgentActionRisk::LowRisk
        } else {
            AgentActionRisk::Elevated
        },
    )
}

fn intent(
    id: &str,
    tool: &str,
    arguments: Value,
    reason: String,
    expected_effect: &str,
    risk: AgentActionRisk,
) -> Result<Option<AgentActionIntent>, String> {
    if id.trim().is_empty() || id.chars().count() > 160 {
        return Err("AI 动作标识无效".to_string());
    }
    Ok(Some(AgentActionIntent {
        id: id.to_string(),
        tool: tool.to_string(),
        arguments,
        reason,
        expected_effect: expected_effect.to_string(),
        risk,
    }))
}

pub(crate) fn proposal_action_intent(
    id: &str,
    tool: &str,
    raw_arguments: &str,
) -> Result<Option<AgentActionIntent>, String> {
    if !matches!(
        tool,
        "propose_file_edit"
            | "propose_file_operation"
            | "propose_terminal_command"
            | "propose_service_action"
    ) {
        return Ok(None);
    }
    let arguments = parse_arguments(raw_arguments)?;
    match tool {
        "propose_file_edit" => {
            if !exact_keys(&arguments, &["path", "content"]) {
                return Err("AI 文件修改动作参数无效".to_string());
            }
            let path = normalize_remote_action_path(
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 文件修改路径无效".to_string())?,
            )?;
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .filter(|content| valid_content(content))
                .ok_or_else(|| "AI 文件修改内容无效".to_string())?;
            intent(
                id,
                tool,
                json!({ "path": path, "content": content }),
                format!("修改远程文件 {path}"),
                "完整替换指定远程文件的内容",
                AgentActionRisk::ReversibleWrite,
            )
        }
        "propose_file_operation" => {
            let operation = arguments
                .get("operation")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 文件操作类型无效".to_string())?;
            let path = normalize_remote_action_path(
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 文件操作路径无效".to_string())?,
            )?;
            match operation {
                "create" => {
                    if !exact_keys(&arguments, &["operation", "path", "content"]) {
                        return Err("AI 新建文件动作参数无效".to_string());
                    }
                    let content = arguments
                        .get("content")
                        .and_then(Value::as_str)
                        .filter(|content| valid_content(content))
                        .ok_or_else(|| "AI 新建文件内容无效".to_string())?;
                    intent(
                        id,
                        tool,
                        json!({ "operation": operation, "path": path, "content": content }),
                        format!("新建远程文件 {path}"),
                        "在当前远程目录创建文件",
                        AgentActionRisk::ReversibleWrite,
                    )
                }
                "rename" => {
                    if !exact_keys(&arguments, &["operation", "path", "target_path"]) {
                        return Err("AI 重命名文件动作参数无效".to_string());
                    }
                    let target_path = normalize_remote_action_path(
                        arguments
                            .get("target_path")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "AI 重命名目标路径无效".to_string())?,
                    )?;
                    if target_path == path {
                        return Err("AI 重命名目标不能与源文件相同".to_string());
                    }
                    intent(
                        id,
                        tool,
                        json!({
                            "operation": operation,
                            "path": path,
                            "targetPath": target_path,
                        }),
                        format!("将远程文件 {path} 重命名为 {target_path}"),
                        "在原目录内重命名远程文件",
                        AgentActionRisk::ReversibleWrite,
                    )
                }
                "delete" => {
                    if !exact_keys(&arguments, &["operation", "path"]) {
                        return Err("AI 删除文件动作参数无效".to_string());
                    }
                    intent(
                        id,
                        tool,
                        json!({ "operation": operation, "path": path }),
                        format!("删除远程文件 {path}"),
                        "删除指定远程文件",
                        AgentActionRisk::Elevated,
                    )
                }
                _ => Err("AI 文件操作类型无效".to_string()),
            }
        }
        "propose_terminal_command" => {
            if !exact_keys(&arguments, &["command", "purpose", "risk", "risk_reason"])
                && !exact_keys(
                    &arguments,
                    &["command", "purpose", "risk", "risk_reason", "verification"],
                )
            {
                return Err("AI 终端命令动作参数无效".to_string());
            }
            let command = arguments
                .get("command")
                .and_then(Value::as_str)
                .filter(|command| valid_command(command))
                .map(str::trim)
                .ok_or_else(|| "AI 终端命令无效".to_string())?;
            let purpose = normalize_purpose(
                arguments
                    .get("purpose")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 命令用途无效".to_string())?,
            )?;
            let ai_risk = arguments
                .get("risk")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 命令风险等级无效".to_string())?;
            normalize_risk_reason(
                arguments
                    .get("risk_reason")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 命令风险说明无效".to_string())?,
            )?;
            let risk = terminal_action_risk(command, ai_risk)?;
            let verification = arguments
                .get("verification")
                .cloned()
                .map(AgentBusinessVerification::normalized_value)
                .transpose()?;
            let mut normalized = json!({ "command": command, "purpose": purpose });
            if let Some(verification) = verification {
                normalized["verification"] = verification;
            }
            intent(
                id,
                TERMINAL_EXECUTE_ACTION_TOOL,
                normalized,
                purpose,
                "通过独立后台 SSH 连接执行命令并采集结果",
                risk,
            )
        }
        "propose_service_action" => {
            if !exact_keys(&arguments, &["service", "action"]) {
                return Err("AI 服务操作参数无效".to_string());
            }
            let service = arguments
                .get("service")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 服务名称无效".to_string())?;
            let action = arguments
                .get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 服务操作类型无效".to_string())?;
            let (command, purpose, expected_effect, risk, verification) =
                service_action_command(service, action)?;
            let mut normalized = json!({ "command": command, "purpose": purpose });
            if let Some(verification) = verification {
                normalized["verification"] = verification;
            }
            intent(
                id,
                TERMINAL_EXECUTE_ACTION_TOOL,
                normalized,
                purpose,
                &expected_effect,
                risk,
            )
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{proposal_action_intent, TERMINAL_EXECUTE_ACTION_TOOL};
    use crate::agent::AgentActionRisk;

    #[test]
    fn creates_normalized_file_and_command_intents() {
        let edit = proposal_action_intent(
            "edit-1",
            "propose_file_edit",
            r#"{"path":"/etc//nginx.conf","content":"server {}"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(edit.arguments["path"], "/etc/nginx.conf");
        assert_eq!(edit.risk, AgentActionRisk::ReversibleWrite);

        let rename = proposal_action_intent(
            "rename-1",
            "propose_file_operation",
            r#"{"operation":"rename","path":"/tmp/a","target_path":"/tmp/b"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(rename.arguments["targetPath"], "/tmp/b");
        assert_eq!(rename.risk, AgentActionRisk::ReversibleWrite);

        let command = proposal_action_intent(
            "command-1",
            "propose_terminal_command",
            r#"{"command":"  systemctl status nginx  ","purpose":"检查  nginx   状态","risk":"safe","risk_reason":"只读取服务状态"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            command.arguments,
            json!({
                "command": "systemctl status nginx",
                "purpose": "检查 nginx 状态",
            })
        );
        assert_eq!(command.risk, AgentActionRisk::LowRisk);
        assert_eq!(command.tool, TERMINAL_EXECUTE_ACTION_TOOL);

        let verified_command = proposal_action_intent(
            "command-2",
            "propose_terminal_command",
            r#"{"command":"systemctl restart nginx","purpose":"重启服务","risk":"caution","risk_reason":"会重启正在运行的服务","verification":{"kind":"service_active","service":"nginx.service"}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            verified_command.arguments["verification"],
            json!({ "kind": "service_active", "service": "nginx.service" })
        );
        assert_eq!(verified_command.risk, AgentActionRisk::Elevated);

        let understated = proposal_action_intent(
            "command-3",
            "propose_terminal_command",
            r#"{"command":"sudo rm -rf /tmp/cache","purpose":"清理缓存","risk":"safe","risk_reason":"清理临时文件"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(understated.risk, AgentActionRisk::Elevated);

        let stop_service = proposal_action_intent(
            "service-1",
            "propose_service_action",
            r#"{"service":"nginx.service","action":"stop"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(stop_service.tool, TERMINAL_EXECUTE_ACTION_TOOL);
        assert_eq!(stop_service.risk, AgentActionRisk::Elevated);
        assert_eq!(
            stop_service.arguments,
            json!({
                "command": "sudo -n systemctl stop -- nginx.service",
                "purpose": "停止服务 nginx.service",
                "verification": {
                    "kind": "service_inactive",
                    "service": "nginx.service",
                },
            })
        );

        let inspect_service = proposal_action_intent(
            "service-2",
            "propose_service_action",
            r#"{"service":"sshd","action":"status"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(inspect_service.risk, AgentActionRisk::LowRisk);
        assert_eq!(
            inspect_service.arguments["command"],
            "systemctl is-active -- sshd"
        );
    }

    #[test]
    fn classifies_delete_as_elevated_and_ignores_diagnostics() {
        let delete = proposal_action_intent(
            "delete-1",
            "propose_file_operation",
            r#"{"operation":"delete","path":"/tmp/old.log"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(delete.risk, AgentActionRisk::Elevated);
        assert!(
            proposal_action_intent("status-1", "get_server_status", "{}")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_actions() {
        for arguments in [
            r#"{"operation":"delete","path":"/"}"#,
            r#"{"operation":"delete","path":"/tmp/../etc/passwd"}"#,
            r#"{"operation":"rename","path":"/tmp/a","target_path":"/tmp/a"}"#,
        ] {
            assert!(
                proposal_action_intent("operation-1", "propose_file_operation", arguments).is_err()
            );
        }
        assert!(proposal_action_intent(
            "command-1",
            "propose_terminal_command",
            r#"{"command":"echo ok\necho unsafe","purpose":"测试","risk":"safe","risk_reason":"输出文本"}"#,
        )
        .is_err());
        assert!(proposal_action_intent(
            "service-1",
            "propose_service_action",
            r#"{"service":"nginx; reboot","action":"restart"}"#,
        )
        .is_err());
    }
}
