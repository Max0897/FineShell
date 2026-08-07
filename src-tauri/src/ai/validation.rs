use super::*;

pub(super) fn private_key_regex() -> Regex {
    Regex::new(r"(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----")
        .expect("private key regex must be valid")
}

pub(super) fn bearer_regex() -> Regex {
    Regex::new(r#"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s\"']+"#)
        .expect("bearer regex must be valid")
}

pub(super) fn secret_assignment_regex() -> Regex {
    Regex::new(
        r#"(?im)\b(password|passwd|api[_-]?key|access[_-]?token|secret)\b[\"']?\s*[:=]\s*[\"']?([^\s,;\"'}]+)"#,
    )
    .expect("secret assignment regex must be valid")
}

pub(super) fn secret_argument_regex() -> Regex {
    Regex::new(
        r#"(?i)(^|[\s\"'\\])(--?(?:password|passphrase|api[_-]?key|access[_-]?token|secret|token)\s+)[^\s,;\"'}]+"#,
    )
    .expect("secret argument regex must be valid")
}

pub(super) fn sanitize_context(value: &str) -> String {
    let limited = value.chars().take(MAX_CONTEXT_CHARS).collect::<String>();
    let value = private_key_regex().replace_all(&limited, "[PRIVATE KEY REDACTED]");
    let value = bearer_regex().replace_all(&value, "${1}[REDACTED]");
    let value = secret_assignment_regex()
        .replace_all(&value, "${1}=[REDACTED]")
        .into_owned();
    secret_argument_regex()
        .replace_all(&value, "${1}${2}[REDACTED]")
        .into_owned()
}

pub(super) fn validate_messages(
    messages: Vec<AiChatMessage>,
) -> Result<Vec<AiChatMessage>, String> {
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err("AI 对话消息数量无效".to_string());
    }
    let mut total_chars = 0usize;
    for message in &messages {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err("AI 对话包含不支持的消息角色".to_string());
        }
        if message.content.trim().is_empty() {
            return Err("AI 对话消息不能为空".to_string());
        }
        total_chars = total_chars.saturating_add(message.content.chars().count());
    }
    if total_chars > MAX_MESSAGE_CHARS {
        return Err("AI 对话内容过长，请新建对话后重试".to_string());
    }
    Ok(messages)
}

pub(super) fn supported_tool(name: &str) -> bool {
    matches!(
        name,
        "get_server_status"
            | "list_processes"
            | "get_current_directory"
            | "get_network_connections"
            | "inspect_service"
            | "read_service_logs"
            | "ping_target"
            | "trace_route"
            | "propose_terminal_command"
            | "propose_service_action"
            | "propose_file_edit"
            | "propose_file_operation"
    )
}

pub(super) fn file_mutation_tool(name: &str) -> bool {
    matches!(name, "propose_file_edit" | "propose_file_operation")
}

pub(super) fn command_proposal_tool(name: &str) -> bool {
    matches!(name, "propose_terminal_command" | "propose_service_action")
}

pub(super) fn diagnostic_tool(name: &str) -> bool {
    !file_mutation_tool(name) && !command_proposal_tool(name) && supported_tool(name)
}

pub(super) fn enabled_diagnostic_tools(
    values: Vec<String>,
    legacy_enabled: bool,
) -> Result<HashSet<String>, String> {
    if values.is_empty() && legacy_enabled {
        return Ok([
            "get_server_status",
            "list_processes",
            "get_current_directory",
            "get_network_connections",
            "inspect_service",
            "read_service_logs",
            "ping_target",
            "trace_route",
        ]
        .into_iter()
        .map(str::to_string)
        .collect());
    }
    if values.len() > 8 {
        return Err("AI 只读工具权限数量无效".to_string());
    }
    let mut enabled = HashSet::new();
    for value in values {
        if !diagnostic_tool(&value) || !enabled.insert(value) {
            return Err("AI 只读工具权限无效".to_string());
        }
    }
    Ok(enabled)
}

pub(super) fn validate_enabled_diagnostic_calls(
    rounds: &[AiToolRound],
    enabled_tools: &HashSet<String>,
) -> Result<(), String> {
    if rounds
        .iter()
        .flat_map(|round| &round.calls)
        .any(|call| diagnostic_tool(&call.name) && !enabled_tools.contains(&call.name))
    {
        return Err("AI 工具调用未获得权限".to_string());
    }
    Ok(())
}

pub(super) fn tool_allowed(
    name: &str,
    diagnostics_enabled: bool,
    file_edit_enabled: bool,
    command_proposal_enabled: bool,
) -> bool {
    (diagnostics_enabled && diagnostic_tool(name))
        || (file_edit_enabled && file_mutation_tool(name))
        || (command_proposal_enabled && command_proposal_tool(name))
}

pub(super) fn valid_remote_tool_path(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|path| normalize_remote_action_path(path).is_ok())
}

pub(super) fn valid_network_target(target: &str) -> bool {
    let target = target.trim();
    !target.is_empty()
        && target.len() <= 253
        && !target.starts_with('-')
        && target.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':')
        })
}

pub(super) fn valid_service_name(service: &str) -> bool {
    let service = service.trim();
    !service.is_empty()
        && service.len() <= 128
        && !service.starts_with('-')
        && service.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '@' | ':')
        })
}

fn valid_service_diagnostic_metadata(
    arguments: &serde_json::Map<String, Value>,
    allow_lines: bool,
) -> bool {
    let Some(service) = arguments.get("service").and_then(Value::as_str) else {
        return false;
    };
    if !valid_service_name(service) {
        return false;
    }
    if allow_lines
        && arguments.get("lines").is_some_and(|value| {
            !value
                .as_u64()
                .is_some_and(|lines| (1..=200).contains(&lines))
        })
    {
        return false;
    }
    let mut metadata = arguments.clone();
    metadata.remove("service");
    metadata.remove("lines");
    valid_diagnostic_metadata(&metadata, false)
}

pub(super) fn valid_diagnostic_metadata(
    arguments: &serde_json::Map<String, Value>,
    target_required: bool,
) -> bool {
    let allowed = |key: &str| {
        matches!(key, "reason" | "optional" | "depends_on") || (target_required && key == "target")
    };
    if arguments.keys().any(|key| !allowed(key)) {
        return false;
    }
    if target_required
        && !arguments
            .get("target")
            .and_then(Value::as_str)
            .is_some_and(valid_network_target)
    {
        return false;
    }
    if arguments.get("reason").is_some_and(|reason| {
        !reason.as_str().is_some_and(|reason| {
            let reason = reason.trim();
            !reason.is_empty()
                && reason.chars().count() <= MAX_DIAGNOSTIC_REASON_CHARS
                && !reason.chars().any(|character| {
                    character.is_control() && !matches!(character, '\r' | '\n' | '\t')
                })
        })
    }) {
        return false;
    }
    if arguments
        .get("optional")
        .is_some_and(|optional| !optional.is_boolean())
    {
        return false;
    }
    if let Some(dependencies) = arguments.get("depends_on") {
        let Some(dependencies) = dependencies.as_array() else {
            return false;
        };
        let mut unique = HashSet::new();
        if dependencies.len() > MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND.saturating_sub(1)
            || dependencies.iter().any(|dependency| {
                !dependency.as_u64().is_some_and(|index| {
                    index >= 1
                        && index <= MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND as u64
                        && unique.insert(index)
                })
            })
        {
            return false;
        }
    }
    true
}

pub(super) fn diagnostic_call_identity(call: &AiToolCall) -> Option<String> {
    if !diagnostic_tool(&call.name) {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(&call.arguments).ok()?;
    let target = arguments
        .get("target")
        .or_else(|| arguments.get("service"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    Some(format!("{}:{target}", call.name))
}

pub(super) fn validate_diagnostic_plan_calls(calls: &[AiToolCall]) -> Result<(), String> {
    let diagnostic_calls = calls
        .iter()
        .filter(|call| diagnostic_tool(&call.name))
        .collect::<Vec<_>>();
    if diagnostic_calls.len() > MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND {
        return Err("AI 单轮诊断工具调用数量超过限制".to_string());
    }
    let mut identities = HashSet::new();
    for (index, call) in diagnostic_calls.iter().enumerate() {
        let Some(identity) = diagnostic_call_identity(call) else {
            return Err("AI 返回了无效的诊断计划".to_string());
        };
        if !identities.insert(identity) {
            return Err("AI 诊断计划包含重复步骤".to_string());
        }
        let arguments = serde_json::from_str::<Value>(&call.arguments)
            .map_err(|_| "AI 返回了无效的诊断计划".to_string())?;
        if arguments
            .get("depends_on")
            .and_then(Value::as_array)
            .is_some_and(|dependencies| {
                dependencies.iter().any(|dependency| {
                    dependency
                        .as_u64()
                        .is_none_or(|dependency| dependency == 0 || dependency > index as u64)
                })
            })
        {
            return Err("AI 诊断步骤只能依赖此前的计划步骤".to_string());
        }
    }
    Ok(())
}

fn validate_tool_call_composition(calls: &[AiToolCall]) -> Result<(), String> {
    let has_diagnostic = calls.iter().any(|call| diagnostic_tool(&call.name));
    let has_action = calls
        .iter()
        .any(|call| file_mutation_tool(&call.name) || command_proposal_tool(&call.name));
    if has_diagnostic && has_action {
        return Err(
            "AI 同一响应不能同时包含诊断工具和操作提案，请先完成诊断再提出操作".to_string(),
        );
    }
    Ok(())
}

pub(super) fn valid_tool_arguments(name: &str, arguments: &str) -> bool {
    let Ok(Value::Object(arguments)) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    match name {
        "get_server_status"
        | "list_processes"
        | "get_current_directory"
        | "get_network_connections" => valid_diagnostic_metadata(&arguments, false),
        "inspect_service" => valid_service_diagnostic_metadata(&arguments, false),
        "read_service_logs" => valid_service_diagnostic_metadata(&arguments, true),
        "ping_target" | "trace_route" => valid_diagnostic_metadata(&arguments, true),
        "propose_file_edit" => {
            arguments.len() == 2
                && arguments.get("path").is_some_and(valid_remote_tool_path)
                && arguments
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| {
                        content.chars().count() <= MAX_FILE_EDIT_CHARS && !content.contains('\0')
                    })
        }
        "propose_file_operation" => {
            let operation = arguments.get("operation").and_then(Value::as_str);
            let path_valid = arguments.get("path").is_some_and(valid_remote_tool_path);
            match operation {
                Some("create") => {
                    arguments.len() == 3
                        && path_valid
                        && arguments
                            .get("content")
                            .and_then(Value::as_str)
                            .is_some_and(|content| {
                                content.chars().count() <= MAX_FILE_EDIT_CHARS
                                    && !content.contains('\0')
                            })
                }
                Some("rename") => {
                    arguments.len() == 3
                        && path_valid
                        && arguments
                            .get("target_path")
                            .is_some_and(valid_remote_tool_path)
                }
                Some("delete") => arguments.len() == 2 && path_valid,
                _ => false,
            }
        }
        "propose_terminal_command" => {
            (arguments.len() == 4
                || (arguments.len() == 5
                    && arguments.get("verification").is_some_and(|verification| {
                        crate::agent_verification::AgentBusinessVerification::from_value(
                            verification.clone(),
                        )
                        .is_ok()
                    })))
                && arguments
                    .get("risk")
                    .and_then(Value::as_str)
                    .is_some_and(|risk| matches!(risk, "safe" | "caution" | "danger"))
                && arguments
                    .get("risk_reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| {
                        let reason = reason.trim();
                        !reason.is_empty()
                            && reason.chars().count() <= MAX_COMMAND_RISK_REASON_CHARS
                            && !reason.chars().any(char::is_control)
                    })
                && arguments
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(crate::agent_actions::valid_command)
                && arguments
                    .get("purpose")
                    .and_then(Value::as_str)
                    .is_some_and(|purpose| {
                        let purpose = purpose.trim();
                        !purpose.is_empty()
                            && purpose.chars().count() <= MAX_COMMAND_PURPOSE_CHARS
                            && !purpose.chars().any(|character| {
                                character.is_control() && !matches!(character, '\r' | '\n' | '\t')
                            })
                    })
        }
        "propose_service_action" => {
            arguments.len() == 2
                && arguments
                    .get("service")
                    .and_then(Value::as_str)
                    .is_some_and(crate::agent_actions::valid_service_name)
                && arguments
                    .get("action")
                    .and_then(Value::as_str)
                    .is_some_and(|action| matches!(action, "status" | "start" | "stop" | "restart"))
        }
        _ => false,
    }
}

fn tool_call_argument_error(call: &AiToolCall) -> Option<String> {
    if call.arguments.chars().count() > MAX_TOOL_ARGUMENT_CHARS {
        return Some("AI 工具调用参数超过长度限制".to_string());
    }
    if diagnostic_tool(&call.name) {
        return (!valid_tool_arguments(&call.name, &call.arguments))
            .then(|| "AI 只读工具参数不符合工具定义".to_string());
    }
    proposal_action_intent(&call.id, &call.name, &call.arguments)
        .err()
        .or_else(|| {
            (!valid_tool_arguments(&call.name, &call.arguments))
                .then(|| "AI 动作工具参数不符合工具定义".to_string())
        })
}

pub(super) fn invalid_tool_call_round(
    calls: &[AiToolCall],
    content: &str,
    reasoning_content: Option<&str>,
) -> Option<AiToolRound> {
    let mut errors = calls
        .iter()
        .map(tool_call_argument_error)
        .collect::<Vec<_>>();
    let batch_error = validate_tool_call_composition(calls)
        .and_then(|_| validate_diagnostic_plan_calls(calls))
        .err();
    if errors.iter().all(Option::is_none) && batch_error.is_none() {
        return None;
    }

    let retry_instruction = if batch_error
        .as_deref()
        .is_some_and(|error| error.contains("同时包含诊断工具和操作提案"))
    {
        "Return either diagnostic calls or action proposals in this response, never both. Complete diagnostics first, consume their results, then propose actions in a later response."
    } else {
        "Correct the tool arguments and return the complete tool call set again. Do not claim that any rejected call was executed."
    };
    let results = calls
        .iter()
        .zip(errors.iter_mut())
        .map(|(call, error)| {
            let error = error
                .take()
                .or_else(|| batch_error.clone())
                .unwrap_or_else(|| "同一响应中包含无效工具调用，因此本调用未执行".to_string());
            AiToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                content: json!({
                    "ok": false,
                    "error": sanitize_context(&error).chars().take(300).collect::<String>(),
                    "retryable": true,
                    "instruction": retry_instruction,
                })
                .to_string(),
            }
        })
        .collect();

    Some(AiToolRound {
        calls: calls.to_vec(),
        content: (!content.trim().is_empty()).then(|| content.trim().to_string()),
        reasoning_content: reasoning_content.map(str::to_string),
        results,
    })
}

pub(super) fn validate_tool_rounds(
    mut rounds: Vec<AiToolRound>,
    diagnostics_enabled: bool,
    file_edit_enabled: bool,
    command_proposal_enabled: bool,
) -> Result<Vec<AiToolRound>, String> {
    if !diagnostics_enabled && !file_edit_enabled && !command_proposal_enabled && !rounds.is_empty()
    {
        return Err("AI 工具调用未启用".to_string());
    }
    let mut total_result_chars = 0usize;
    let mut total_tool_calls = 0usize;
    let mut all_call_ids = HashSet::new();
    for round in &mut rounds {
        total_tool_calls = total_tool_calls.saturating_add(round.calls.len());
        if total_tool_calls > MAX_TOOL_CALLS {
            return Err("AI 工具调用总数超过限制".to_string());
        }
        if round.calls.is_empty()
            || round.calls.len() > MAX_TOOL_CALLS_PER_ROUND
            || round
                .calls
                .iter()
                .filter(|call| diagnostic_tool(&call.name))
                .count()
                > MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND
            || round.calls.len() != round.results.len()
        {
            return Err("AI 工具调用数量无效".to_string());
        }
        if round
            .content
            .as_ref()
            .is_some_and(|content| content.chars().count() > 8_000)
        {
            return Err("AI 工具调用说明过长".to_string());
        }
        if round.reasoning_content.as_ref().is_some_and(|reasoning| {
            reasoning.is_empty() || reasoning.chars().count() > MAX_REASONING_CONTENT_CHARS
        }) {
            return Err("AI 工具调用推理内容无效".to_string());
        }
        for call in &round.calls {
            if call.id.trim().is_empty()
                || call.id.len() > 160
                || !all_call_ids.insert(call.id.as_str())
                || !tool_allowed(
                    &call.name,
                    diagnostics_enabled,
                    file_edit_enabled,
                    command_proposal_enabled,
                )
                || call.arguments.chars().count() > MAX_TOOL_ARGUMENT_CHARS
                || !valid_tool_arguments(&call.name, &call.arguments)
            {
                return Err("AI 工具调用内容无效".to_string());
            }
        }
        validate_diagnostic_plan_calls(&round.calls)?;
        let mut result_ids = HashSet::new();
        for result in &mut round.results {
            let Some(call) = round.calls.iter().find(|call| call.id == result.call_id) else {
                return Err("AI 工具结果与调用不匹配".to_string());
            };
            if !result_ids.insert(result.call_id.as_str())
                || call.name != result.name
                || result.content.trim().is_empty()
                || result.content.chars().count() > MAX_TOOL_RESULT_CHARS
            {
                return Err("AI 工具结果无效".to_string());
            }
            total_result_chars = total_result_chars.saturating_add(result.content.chars().count());
            if total_result_chars > MAX_TOOL_RESULTS_TOTAL_CHARS {
                return Err("AI 工具结果总长度超过限制".to_string());
            }
            result.content = sanitize_context(&result.content);
        }
    }
    Ok(rounds)
}
