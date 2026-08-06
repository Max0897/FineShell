use super::*;

pub(super) fn tool_definitions(
    diagnostics_enabled: bool,
    file_edit_enabled: bool,
    command_proposal_enabled: bool,
) -> Value {
    let mut definitions = Vec::new();
    if diagnostics_enabled {
        definitions.extend(json!([
        {
            "type": "function",
            "function": {
                "name": "get_server_status",
                "description": "Read the current server operating system, uptime, load, CPU, memory, disk, and cumulative network counters.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_processes",
                "description": "Read a bounded process list sorted by resource usage. Use it to identify high CPU or memory consumers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_current_directory",
                "description": "Read the current remote directory shown by the SFTP file manager.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_network_connections",
                "description": "Read a bounded list of the server's current TCP and UDP connections. Use it to inspect listening services and active remote peers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "ping_target",
                "description": "Run a bounded three-packet Ping from the connected server to a hostname or IP address.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target": { "type": "string", "description": "Hostname or IPv4/IPv6 address", "maxLength": 253 },
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "required": ["target"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "trace_route",
                "description": "Run a bounded route trace of at most 12 hops from the connected server to a hostname or IP address.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target": { "type": "string", "description": "Hostname or IPv4/IPv6 address", "maxLength": 253 },
                        "reason": { "type": "string", "description": "Short reason for this diagnostic step", "maxLength": MAX_DIAGNOSTIC_REASON_CHARS },
                        "optional": { "type": "boolean", "description": "True only when the user may omit this step without weakening the core diagnosis" },
                        "depends_on": { "type": "array", "description": "One-based indexes of earlier diagnostic steps required by this step", "items": { "type": "integer", "minimum": 1, "maximum": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND }, "maxItems": MAX_DIAGNOSTIC_TOOL_CALLS_PER_ROUND - 1 }
                    },
                    "required": ["target"],
                    "additionalProperties": false
                }
            }
        }
        ])
        .as_array()
        .cloned()
        .unwrap_or_default());
    }
    if file_edit_enabled {
        definitions.push(json!({
            "type": "function",
            "function": {
                "name": "propose_file_edit",
                "description": "Create one review-only proposal that replaces one complete remote UTF-8 file. Call once per file when multiple files must change. This never writes files. Use only an exact path from complete workspace file context and only when the user asks to modify it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Exact absolute remote path", "maxLength": 1024 },
                        "content": { "type": "string", "description": "Complete replacement UTF-8 file content", "maxLength": MAX_FILE_EDIT_CHARS }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        }));
        definitions.push(json!({
            "type": "function",
            "function": {
                "name": "propose_file_operation",
                "description": "Create one review-only proposal to create, rename, or delete a remote UTF-8 file. This never writes files. Create paths must be in the current remote directory. Rename and delete paths must exactly match complete file context; rename targets must remain in the source file's directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operation": { "type": "string", "enum": ["create", "rename", "delete"] },
                        "path": { "type": "string", "description": "Create/delete path or rename source path", "maxLength": 1024 },
                        "target_path": { "type": "string", "description": "Rename target absolute path", "maxLength": 1024 },
                        "content": { "type": "string", "description": "Complete UTF-8 content for a created file", "maxLength": MAX_FILE_EDIT_CHARS }
                    },
                    "required": ["operation", "path"],
                    "additionalProperties": false
                }
            }
        }));
    }
    if command_proposal_enabled {
        definitions.push(json!({
            "type": "function",
            "function": {
                "name": "propose_service_action",
                "description": "Create a review-only systemd service action. Prefer this over a free-form shell command for checking, starting, stopping, or restarting one service. FineShell generates the exact command, risk classification, and post-action verification from the structured service and action values.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "service": { "type": "string", "description": "Exact systemd unit name, for example nginx.service", "minLength": 1, "maxLength": 128 },
                        "action": { "type": "string", "enum": ["status", "start", "stop", "restart"] }
                    },
                    "required": ["service", "action"],
                    "additionalProperties": false
                }
            }
        }));
        definitions.push(json!({
            "type": "function",
            "function": {
                "name": "propose_terminal_command",
                "description": "Create one review-only single-line shell command proposal. The tool never executes or writes to the terminal by itself; FineShell applies the active approval policy and either executes it automatically or asks the user to approve, reject, or revise it. Call once per command and preserve execution order across multiple calls.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "One syntactically complete shell command without CR, LF, a here-document, or an Enter key", "minLength": 1, "maxLength": MAX_TERMINAL_COMMAND_CHARS, "pattern": "^[^\\r\\n]+$" },
                        "purpose": { "type": "string", "description": "Short explanation of what the command is intended to do", "minLength": 1, "maxLength": MAX_COMMAND_PURPOSE_CHARS },
                        "risk": { "type": "string", "enum": ["safe", "caution", "danger"], "description": "Your safety assessment of this exact command. Use safe only for observational commands with no expected mutation." },
                        "risk_reason": { "type": "string", "description": "Concrete reason for the selected risk level", "minLength": 1, "maxLength": MAX_COMMAND_RISK_REASON_CHARS },
                        "verification": {
                            "description": "Optional registered business verification to run after successful approved execution",
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "service_active" },
                                        "service": { "type": "string", "minLength": 1, "maxLength": 128 }
                                    },
                                    "required": ["kind", "service"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "service_inactive" },
                                        "service": { "type": "string", "minLength": 1, "maxLength": 128 }
                                    },
                                    "required": ["kind", "service"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "port_listening" },
                                        "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                                        "protocol": { "type": "string", "enum": ["tcp", "udp"] }
                                    },
                                    "required": ["kind", "port", "protocol"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "config_syntax" },
                                        "validator": { "type": "string", "enum": ["nginx", "apache", "caddy", "sshd", "haproxy"] },
                                        "path": { "type": "string", "maxLength": 1024 }
                                    },
                                    "required": ["kind", "validator"],
                                    "additionalProperties": false
                                }
                            ]
                        }
                    },
                    "required": ["command", "purpose", "risk", "risk_reason"],
                    "additionalProperties": false
                }
            }
        }));
    }
    Value::Array(definitions)
}

pub(super) fn filter_tool_definitions(
    definitions: Value,
    enabled_tools: &HashSet<String>,
) -> Value {
    let Value::Array(definitions) = definitions else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        definitions
            .into_iter()
            .filter(|definition| {
                definition
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .is_none_or(|name| !diagnostic_tool(name) || enabled_tools.contains(name))
            })
            .collect(),
    )
}

pub(super) fn canonical_tool_value(value: Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.into_iter().map(canonical_tool_value).collect())
        }
        Value::Object(values) => {
            let mut entries = values
                .into_iter()
                .filter(|(key, _)| !matches!(key.as_str(), "depends_on" | "optional" | "reason"))
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonical_tool_value(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

pub(super) fn tool_call_fingerprint(call: &AiToolCall) -> String {
    let arguments = serde_json::from_str::<Value>(&call.arguments)
        .map(canonical_tool_value)
        .unwrap_or_else(|_| Value::String(call.arguments.clone()));
    format!(
        "{}:{}",
        call.name,
        serde_json::to_string(&arguments).unwrap_or_default()
    )
}

pub(super) fn tool_round_failed(round: &AiToolRound) -> bool {
    !round.results.is_empty()
        && round.results.iter().all(|result| {
            serde_json::from_str::<Value>(&result.content)
                .ok()
                .and_then(|value| value.get("ok").and_then(Value::as_bool))
                == Some(false)
        })
}

pub(super) fn tool_loop_finalize_reason(
    rounds: &[AiToolRound],
    next_calls: &[AiToolCall],
) -> Option<AiFinalizeReason> {
    let completed_calls = rounds.iter().map(|round| round.calls.len()).sum::<usize>();
    let completed_result_chars = rounds
        .iter()
        .flat_map(|round| &round.results)
        .map(|result| result.content.chars().count())
        .sum::<usize>();
    if completed_calls.saturating_add(next_calls.len()) > MAX_TOOL_CALLS
        || completed_result_chars >= MAX_RUNTIME_TOOL_RESULT_CHARS
    {
        return Some(AiFinalizeReason::ToolBudget);
    }
    if rounds.len() >= MAX_CONSECUTIVE_FAILED_ROUNDS
        && rounds[rounds.len() - MAX_CONSECUTIVE_FAILED_ROUNDS..]
            .iter()
            .all(tool_round_failed)
    {
        return Some(AiFinalizeReason::ConsecutiveFailures);
    }
    let mut execution_counts = HashMap::<String, usize>::new();
    for call in rounds.iter().flat_map(|round| &round.calls) {
        *execution_counts
            .entry(tool_call_fingerprint(call))
            .or_default() += 1;
    }
    if !next_calls.is_empty()
        && next_calls.iter().all(|call| {
            execution_counts
                .get(&tool_call_fingerprint(call))
                .copied()
                .unwrap_or_default()
                >= MAX_IDENTICAL_TOOL_EXECUTIONS
        })
    {
        return Some(AiFinalizeReason::NoProgress);
    }
    None
}
