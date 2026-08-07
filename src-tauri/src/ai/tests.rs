use std::collections::HashSet;

use reqwest::Url;
use serde_json::{json, Value};

use crate::{
    agent::{
        AgentActionResultSnapshot, AgentActionStatus, AgentCommandExecutionPhase,
        AgentCommandResultSnapshot, AgentTaskContext,
    },
    agent_policy::PolicyDecision,
};

use super::{
    action_round_result, apply_finalization_instruction, apply_tool_call_delta,
    build_request_messages, capability_http_failure, complete_tool_calls, create_diagnostic_plan,
    diagnostic_policy_evaluations, diagnostic_tool_requires_connection, enabled_diagnostic_tools,
    filter_tool_definitions, http_messages, invalid_tool_call_round, is_local_endpoint,
    is_tool_unsupported_error, normalize_models, sanitize_context, service_endpoint, stream_delta,
    stream_tool_call_deltas, tool_allowed, tool_definitions, tool_loop_finalize_reason,
    tool_probe_supported, valid_stream_probe_event, valid_tool_arguments,
    validate_diagnostic_plan_calls, validate_enabled_diagnostic_calls, validate_service_url,
    validate_tool_rounds, AiActionRoundDecision, AiActionRoundDecisionKind, AiCapabilityKind,
    AiCapabilityState, AiChatMessage, AiFinalizeReason, AiModelEntry, AiToolCall, AiToolResult,
    AiToolRound, SseParser,
};

#[test]
fn action_round_result_uses_the_authoritative_command_snapshot() {
    let call = AiToolCall {
        id: "command-1".to_string(),
        name: "propose_terminal_command".to_string(),
        arguments: "{}".to_string(),
    };
    let decision = AiActionRoundDecision {
        call_id: call.id.clone(),
        kind: AiActionRoundDecisionKind::ExecutionCompleted,
        feedback: None,
        error: None,
    };
    let result = action_round_result(
        &call,
        &decision,
        AgentActionResultSnapshot {
            id: call.id.clone(),
            tool: "execute_terminal_command".to_string(),
            status: AgentActionStatus::Succeeded,
            summary: Some("终端命令执行成功".to_string()),
            error: None,
            duration_ms: Some(41),
            command: Some(AgentCommandResultSnapshot {
                phase: AgentCommandExecutionPhase::Completed,
                output: Some("active".to_string()),
                output_truncated: false,
                stdout: Some("active".to_string()),
                stdout_truncated: false,
                stderr: Some(String::new()),
                stderr_truncated: false,
                exit_code: Some(0),
                duration_ms: Some(41),
                reason: None,
            }),
        },
    )
    .unwrap();
    let content: Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(content["decision"], "approved_and_completed");
    assert_eq!(content["exitCode"], 0);
    assert_eq!(content["output"], "active");
}

#[test]
fn action_round_result_preserves_revision_feedback_without_execution_data() {
    let call = AiToolCall {
        id: "command-2".to_string(),
        name: "propose_terminal_command".to_string(),
        arguments: "{}".to_string(),
    };
    let result = action_round_result(
        &call,
        &AiActionRoundDecision {
            call_id: call.id.clone(),
            kind: AiActionRoundDecisionKind::RevisionRequested,
            feedback: Some("只检查状态".to_string()),
            error: None,
        },
        AgentActionResultSnapshot {
            id: call.id.clone(),
            tool: "execute_terminal_command".to_string(),
            status: AgentActionStatus::Rejected,
            summary: Some("用户拒绝了该动作".to_string()),
            error: None,
            duration_ms: None,
            command: None,
        },
    )
    .unwrap();
    let content: Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(content["decision"], "revision_requested");
    assert_eq!(content["feedback"], "只检查状态");
}

fn policy_context(mode: &str) -> AgentTaskContext {
    serde_json::from_value(json!({
        "contextVersion": 1,
        "contextCapturedAt": crate::agent::timestamp_ms(),
        "id": "task-1",
        "conversationId": "conversation-1",
        "hostId": "host-1",
        "terminalSessionId": "session-1",
        "currentDirectory": "/srv/app",
        "objective": "检查网络",
        "approvalMode": mode,
    }))
    .unwrap()
}

#[test]
fn runtime_diagnostic_policy_uses_the_task_approval_mode() {
    let calls = vec![AiToolCall {
        id: "ping-1".to_string(),
        name: "ping_target".to_string(),
        arguments: r#"{"target":"example.com"}"#.to_string(),
    }];
    let enabled = HashSet::from(["ping_target".to_string()]);
    let on_request = diagnostic_policy_evaluations(&policy_context("on_request"), &enabled, &calls);
    let full_access =
        diagnostic_policy_evaluations(&policy_context("full_access"), &enabled, &calls);
    assert_eq!(on_request["ping-1"].decision, PolicyDecision::Prompt);
    assert_eq!(full_access["ping-1"].decision, PolicyDecision::Allow);
}

#[test]
fn only_remote_diagnostic_tools_wait_for_ssh_reconnection() {
    assert!(!diagnostic_tool_requires_connection(
        "get_current_directory"
    ));
    for tool in [
        "get_server_status",
        "list_processes",
        "get_network_connections",
        "ping_target",
        "trace_route",
    ] {
        assert!(diagnostic_tool_requires_connection(tool));
    }
}

#[test]
fn finalization_keeps_evidence_and_disables_further_tool_requests() {
    let mut messages = http_messages(
        vec![AiChatMessage {
            role: "user".to_string(),
            content: "Diagnose the server.".to_string(),
        }],
        None,
        &[AiToolRound {
            calls: vec![AiToolCall {
                id: "call-1".to_string(),
                name: "get_server_status".to_string(),
                arguments: "{}".to_string(),
            }],
            content: None,
            reasoning_content: None,
            results: vec![AiToolResult {
                call_id: "call-1".to_string(),
                name: "get_server_status".to_string(),
                content: r#"{"ok":true}"#.to_string(),
            }],
        }],
        true,
        false,
        false,
    );
    apply_finalization_instruction(&mut messages, AiFinalizeReason::ToolBudget);

    assert!(messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("Do not request or claim to run more tools"));
    assert_eq!(messages[messages.len() - 1]["role"], "tool");
}

#[test]
fn runtime_stops_repeated_calls_and_consecutive_failed_rounds() {
    let call = AiToolCall {
        id: "call-next".to_string(),
        name: "ping_target".to_string(),
        arguments: r#"{"target":"example.com","reason":"check"}"#.to_string(),
    };
    let successful_round = |id: &str| AiToolRound {
        calls: vec![AiToolCall {
            id: id.to_string(),
            ..call.clone()
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: id.to_string(),
            name: call.name.clone(),
            content: r#"{"ok":true}"#.to_string(),
        }],
    };
    assert_eq!(
        tool_loop_finalize_reason(
            &[successful_round("call-1"), successful_round("call-2")],
            std::slice::from_ref(&call),
        ),
        Some(AiFinalizeReason::NoProgress)
    );

    let failed_round = |id: &str| AiToolRound {
        calls: vec![AiToolCall {
            id: id.to_string(),
            name: "get_server_status".to_string(),
            arguments: "{}".to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: id.to_string(),
            name: "get_server_status".to_string(),
            content: r#"{"ok":false,"error":"offline"}"#.to_string(),
        }],
    };
    assert_eq!(
        tool_loop_finalize_reason(
            &[
                failed_round("failed-1"),
                failed_round("failed-2"),
                failed_round("failed-3"),
            ],
            &[AiToolCall {
                id: "status-next".to_string(),
                name: "get_server_status".to_string(),
                arguments: "{}".to_string(),
            }],
        ),
        Some(AiFinalizeReason::ConsecutiveFailures)
    );
}

#[test]
fn repeated_call_detection_ignores_model_planning_metadata() {
    let round = |id: &str, reason: &str, optional: bool| AiToolRound {
        calls: vec![AiToolCall {
            id: id.to_string(),
            name: "ping_target".to_string(),
            arguments: json!({
                "target": "example.com",
                "reason": reason,
                "optional": optional,
            })
            .to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: id.to_string(),
            name: "ping_target".to_string(),
            content: r#"{"ok":true}"#.to_string(),
        }],
    };
    let next = AiToolCall {
        id: "ping-3".to_string(),
        name: "ping_target".to_string(),
        arguments: json!({
            "optional": false,
            "reason": "third wording",
            "target": "example.com",
        })
        .to_string(),
    };

    assert_eq!(
        tool_loop_finalize_reason(
            &[
                round("ping-1", "first wording", true),
                round("ping-2", "second wording", false),
            ],
            &[next],
        ),
        Some(AiFinalizeReason::NoProgress),
    );
}

#[test]
fn runtime_does_not_stop_only_because_the_task_exceeds_ten_rounds() {
    let rounds = (0..12)
        .map(|index| {
            let id = format!("ping-{index}");
            AiToolRound {
                calls: vec![AiToolCall {
                    id: id.clone(),
                    name: "ping_target".to_string(),
                    arguments: json!({
                        "target": format!("host-{index}.example.com"),
                        "reason": "collect evidence",
                    })
                    .to_string(),
                }],
                content: None,
                reasoning_content: None,
                results: vec![AiToolResult {
                    call_id: id,
                    name: "ping_target".to_string(),
                    content: r#"{"ok":true}"#.to_string(),
                }],
            }
        })
        .collect::<Vec<_>>();
    let next = AiToolCall {
        id: "ping-next".to_string(),
        name: "ping_target".to_string(),
        arguments: r#"{"target":"next.example.com","reason":"collect evidence"}"#.to_string(),
    };

    assert_eq!(tool_loop_finalize_reason(&rounds, &[next]), None);
}

#[test]
fn builds_runtime_plan_with_dependency_and_network_approval_metadata() {
    let calls = vec![
        AiToolCall {
            id: "status".to_string(),
            name: "get_server_status".to_string(),
            arguments: r#"{"reason":"读取负载"}"#.to_string(),
        },
        AiToolCall {
            id: "ping".to_string(),
            name: "ping_target".to_string(),
            arguments:
                r#"{"target":"example.com","optional":true,"depends_on":[1],"reason":"检查出口"}"#
                    .to_string(),
        },
    ];
    let plan = create_diagnostic_plan(&calls, "诊断连接", 1);
    assert_eq!(plan.steps[1].depends_on, vec!["status"]);
    assert!(plan.steps[1].optional);
    assert_eq!(plan.steps[1].detail.as_deref(), Some("example.com"));
    assert!(plan.steps[1]
        .summary
        .as_deref()
        .unwrap()
        .contains("主动网络探测"));
}

#[test]
fn builds_chat_completion_endpoint() {
    assert_eq!(
        service_endpoint("https://example.com/v1/", "chat/completions")
            .unwrap()
            .as_str(),
        "https://example.com/v1/chat/completions"
    );
    assert_eq!(
        service_endpoint("https://example.com", "models")
            .unwrap()
            .as_str(),
        "https://example.com/models"
    );
    assert!(validate_service_url("file:///tmp/model").is_err());
    assert!(validate_service_url("http://example.com/v1").is_err());
    assert!(validate_service_url("http://127.0.0.1:11434/v1").is_ok());
}

#[test]
fn identifies_local_services_that_may_omit_an_api_key() {
    assert!(is_local_endpoint(
        &Url::parse("http://localhost:11434/v1").unwrap()
    ));
    assert!(is_local_endpoint(
        &Url::parse("http://127.0.0.1:11434/v1").unwrap()
    ));
    assert!(is_local_endpoint(
        &Url::parse("http://[::1]:11434/v1").unwrap()
    ));
    assert!(!is_local_endpoint(
        &Url::parse("https://api.example.com/v1").unwrap()
    ));
}

#[test]
fn normalizes_model_lists() {
    let models = normalize_models(vec![
        AiModelEntry {
            id: " model-b ".to_string(),
            owned_by: None,
        },
        AiModelEntry {
            id: "model-a".to_string(),
            owned_by: Some("owner".to_string()),
        },
        AiModelEntry {
            id: "model-a".to_string(),
            owned_by: None,
        },
        AiModelEntry {
            id: "".to_string(),
            owned_by: None,
        },
    ]);
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["model-a", "model-b"]
    );
}

#[test]
fn parses_sse_across_chunks() {
    let mut parser = SseParser::default();
    assert!(parser.push(b"data: {\"choices\":[{\"delta\":{").is_empty());
    let events = parser.push(b"\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n");
    assert_eq!(events.len(), 2);
    assert_eq!(stream_delta(&events[0]).unwrap(), Some("hello".to_string()));
    assert_eq!(stream_delta(&events[1]).unwrap(), None);
}

#[test]
fn parses_streamed_read_only_tool_calls() {
    let first = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"get_server_status","arguments":"{"}}]}}]}"#;
    let second =
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}"#;
    let mut calls = Vec::new();
    for data in [first, second] {
        for delta in stream_tool_call_deltas(data).unwrap() {
            apply_tool_call_delta(&mut calls, delta).unwrap();
        }
    }
    let calls = complete_tool_calls(calls).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call-1");
    assert_eq!(calls[0].name, "get_server_status");
    assert_eq!(calls[0].arguments, "{}");
}

#[test]
fn exposes_and_validates_only_explicitly_enabled_diagnostic_tools() {
    let enabled = enabled_diagnostic_tools(
        vec!["get_server_status".to_string(), "ping_target".to_string()],
        false,
    )
    .unwrap();
    let definitions = filter_tool_definitions(tool_definitions(true, false, false), &enabled);
    let names = definitions
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| value.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["get_server_status", "ping_target"]);

    let disabled_round = AiToolRound {
        calls: vec![AiToolCall {
            id: "call-1".to_string(),
            name: "trace_route".to_string(),
            arguments: r#"{"target":"example.com"}"#.to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: "call-1".to_string(),
            name: "trace_route".to_string(),
            content: r#"{"ok":true}"#.to_string(),
        }],
    };
    assert!(validate_enabled_diagnostic_calls(&[disabled_round], &enabled).is_err());
    assert!(enabled_diagnostic_tools(vec!["run_shell_command".to_string()], false).is_err());
}

#[test]
fn validates_and_redacts_tool_results_before_provider_handling() {
    let rounds = validate_tool_rounds(
        vec![AiToolRound {
            calls: vec![AiToolCall {
                id: "call-1".to_string(),
                name: "get_current_directory".to_string(),
                arguments: "{}".to_string(),
            }],
            content: None,
            reasoning_content: Some("inspect the current directory".to_string()),
            results: vec![AiToolResult {
                call_id: "call-1".to_string(),
                name: "get_current_directory".to_string(),
                content: r#"{"path":"/srv/app","password":"secret"}"#.to_string(),
            }],
        }],
        true,
        false,
        false,
    )
    .unwrap();
    let messages = http_messages(
        vec![AiChatMessage {
            role: "user".to_string(),
            content: "Where am I?".to_string(),
        }],
        None,
        &rounds,
        true,
        false,
        false,
    );
    assert_eq!(messages[messages.len() - 2]["role"], "assistant");
    assert_eq!(
        messages[messages.len() - 2]["reasoning_content"],
        "inspect the current directory"
    );
    assert_eq!(messages[messages.len() - 1]["role"], "tool");
    assert!(messages[messages.len() - 1]["content"]
        .as_str()
        .unwrap()
        .contains("password=[REDACTED]"));
}

#[test]
fn validates_more_than_ten_tool_rounds_within_the_resource_budget() {
    let rounds = (0..12)
        .map(|index| {
            let id = format!("call-{index}");
            AiToolRound {
                calls: vec![AiToolCall {
                    id: id.clone(),
                    name: "get_current_directory".to_string(),
                    arguments: "{}".to_string(),
                }],
                content: None,
                reasoning_content: None,
                results: vec![AiToolResult {
                    call_id: id,
                    name: "get_current_directory".to_string(),
                    content: format!(r#"{{"path":"/srv/{index}"}}"#),
                }],
            }
        })
        .collect::<Vec<_>>();

    assert!(validate_tool_rounds(rounds, true, false, false).is_ok());
}

#[test]
fn rejects_tools_outside_the_read_only_allowlist() {
    let result = validate_tool_rounds(
        vec![AiToolRound {
            calls: vec![AiToolCall {
                id: "call-1".to_string(),
                name: "run_shell_command".to_string(),
                arguments: "{}".to_string(),
            }],
            content: None,
            reasoning_content: None,
            results: vec![AiToolResult {
                call_id: "call-1".to_string(),
                name: "run_shell_command".to_string(),
                content: "not executed".to_string(),
            }],
        }],
        true,
        false,
        false,
    );
    assert!(result.is_err());
}

#[test]
fn validates_bounded_network_tool_arguments() {
    assert!(valid_tool_arguments(
        "ping_target",
        r#"{"target":"example.com"}"#
    ));
    assert!(valid_tool_arguments(
        "trace_route",
        r#"{"target":"2001:db8::1"}"#
    ));
    assert!(!valid_tool_arguments(
        "ping_target",
        r#"{"target":"example.com; reboot"}"#
    ));
    assert!(!valid_tool_arguments(
        "ping_target",
        r#"{"target":"example.com","count":100}"#
    ));
    assert!(!valid_tool_arguments(
        "get_server_status",
        r#"{"unexpected":true}"#
    ));
    assert!(valid_tool_arguments(
        "ping_target",
        r#"{"target":"example.com","reason":"Check reachability","optional":true,"depends_on":[1]}"#
    ));
    assert!(!valid_tool_arguments(
        "get_server_status",
        r#"{"depends_on":[1,1]}"#
    ));
}

#[test]
fn validates_structured_service_diagnostic_arguments() {
    assert!(valid_tool_arguments(
        "inspect_service",
        r#"{"service":"nginx.service"}"#
    ));
    assert!(valid_tool_arguments(
        "read_service_logs",
        r#"{"service":"nginx.service","lines":100,"reason":"Inspect recent failures"}"#
    ));
    assert!(!valid_tool_arguments(
        "inspect_service",
        r#"{"service":"nginx.service; reboot"}"#
    ));
    assert!(!valid_tool_arguments(
        "read_service_logs",
        r#"{"service":"nginx.service","lines":1000}"#
    ));
}

#[test]
fn validates_diagnostic_plan_order_duplicates_and_limit() {
    let valid = vec![
        AiToolCall {
            id: "call-1".to_string(),
            name: "get_server_status".to_string(),
            arguments: r#"{"reason":"Read resources"}"#.to_string(),
        },
        AiToolCall {
            id: "call-2".to_string(),
            name: "ping_target".to_string(),
            arguments: r#"{"target":"example.com","reason":"Check reachability","depends_on":[1]}"#
                .to_string(),
        },
    ];
    assert!(validate_diagnostic_plan_calls(&valid).is_ok());

    let duplicate = vec![
        valid[0].clone(),
        AiToolCall {
            id: "call-duplicate".to_string(),
            name: "get_server_status".to_string(),
            arguments: "{}".to_string(),
        },
    ];
    assert!(matches!(
        validate_diagnostic_plan_calls(&duplicate),
        Err(error) if error.contains("重复步骤")
    ));

    let invalid_dependency = vec![AiToolCall {
        id: "call-forward".to_string(),
        name: "get_server_status".to_string(),
        arguments: r#"{"depends_on":[1]}"#.to_string(),
    }];
    assert!(matches!(
        validate_diagnostic_plan_calls(&invalid_dependency),
        Err(error) if error.contains("此前")
    ));

    let oversized = (0..7)
        .map(|index| AiToolCall {
            id: format!("call-{index}"),
            name: "ping_target".to_string(),
            arguments: format!(r#"{{"target":"host-{index}"}}"#),
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        validate_diagnostic_plan_calls(&oversized),
        Err(error) if error.contains("数量超过限制")
    ));
}

#[test]
fn rejects_tool_rounds_when_read_only_tools_are_disabled() {
    let result = validate_tool_rounds(
        vec![AiToolRound {
            calls: vec![AiToolCall {
                id: "call-1".to_string(),
                name: "ping_target".to_string(),
                arguments: r#"{"target":"example.com"}"#.to_string(),
            }],
            content: None,
            reasoning_content: None,
            results: vec![AiToolResult {
                call_id: "call-1".to_string(),
                name: "ping_target".to_string(),
                content: r#"{"ok":true}"#.to_string(),
            }],
        }],
        false,
        false,
        false,
    );
    assert!(matches!(
        result,
        Err(error) if error == "AI 工具调用未启用"
    ));
}

#[test]
fn accepts_file_edit_proposals_without_enabling_diagnostics() {
    let arguments = r#"{"path":"/etc/app.conf","content":"port=8080\n"}"#;
    assert!(valid_tool_arguments("propose_file_edit", arguments));
    let definitions = tool_definitions(false, true, false);
    let names = definitions
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| value.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["propose_file_edit", "propose_file_operation"]);
    assert!(tool_allowed("propose_file_edit", false, true, false));
    assert!(tool_allowed("propose_file_operation", false, true, false));
    assert!(!tool_allowed("get_server_status", false, true, false));

    let round = AiToolRound {
        calls: vec![AiToolCall {
            id: "call-file-edit".to_string(),
            name: "propose_file_edit".to_string(),
            arguments: arguments.to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: "call-file-edit".to_string(),
            name: "propose_file_edit".to_string(),
            content: r#"{"ok":true,"proposalCaptured":true}"#.to_string(),
        }],
    };
    assert!(validate_tool_rounds(vec![round], false, true, false).is_ok());

    let unauthorized_round = AiToolRound {
        calls: vec![AiToolCall {
            id: "call-file-edit".to_string(),
            name: "propose_file_edit".to_string(),
            arguments: arguments.to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: "call-file-edit".to_string(),
            name: "propose_file_edit".to_string(),
            content: r#"{"ok":true}"#.to_string(),
        }],
    };
    assert!(validate_tool_rounds(vec![unauthorized_round], true, false, false).is_err());

    for arguments in [
        r#"{"operation":"create","path":"/etc/new.conf","content":"enabled=true\n"}"#,
        r#"{"operation":"rename","path":"/etc/app.conf","target_path":"/etc/app.old.conf"}"#,
        r#"{"operation":"delete","path":"/etc/app.conf"}"#,
    ] {
        assert!(valid_tool_arguments("propose_file_operation", arguments));
    }
    assert!(!valid_tool_arguments(
        "propose_file_operation",
        r#"{"operation":"delete","path":"relative.conf"}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_file_operation",
        r#"{"operation":"create","path":"/etc/new.conf"}"#
    ));

    let batch_round = AiToolRound {
        calls: (0..8)
            .map(|index| AiToolCall {
                id: format!("call-file-{index}"),
                name: "propose_file_edit".to_string(),
                arguments: format!(r#"{{"path":"/etc/{index}.conf","content":"enabled=true\n"}}"#),
            })
            .collect(),
        content: None,
        reasoning_content: None,
        results: (0..8)
            .map(|index| AiToolResult {
                call_id: format!("call-file-{index}"),
                name: "propose_file_edit".to_string(),
                content: r#"{"ok":true}"#.to_string(),
            })
            .collect(),
    };
    assert!(validate_tool_rounds(vec![batch_round], false, true, false).is_ok());

    let diagnostic_round = AiToolRound {
        calls: (0..4)
            .map(|index| AiToolCall {
                id: format!("call-diagnostic-{index}"),
                name: "get_server_status".to_string(),
                arguments: "{}".to_string(),
            })
            .collect(),
        content: None,
        reasoning_content: None,
        results: (0..4)
            .map(|index| AiToolResult {
                call_id: format!("call-diagnostic-{index}"),
                name: "get_server_status".to_string(),
                content: r#"{"ok":true}"#.to_string(),
            })
            .collect(),
    };
    assert!(validate_tool_rounds(vec![diagnostic_round], true, false, false).is_err());
}

#[test]
fn accepts_review_only_terminal_command_proposals() {
    let arguments = r#"{"command":"sudo systemctl restart nginx","purpose":"Restart nginx","risk":"caution","risk_reason":"Restarts a running service"}"#;
    assert!(valid_tool_arguments("propose_terminal_command", arguments));
    assert!(valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"sudo systemctl restart nginx","purpose":"Restart nginx","risk":"caution","risk_reason":"Restarts a running service","verification":{"kind":"service_active","service":"nginx.service"}}"#
    ));
    assert!(valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"sudo systemctl stop nginx","purpose":"Stop nginx","risk":"caution","risk_reason":"Stops a running service","verification":{"kind":"service_inactive","service":"nginx.service"}}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"sudo systemctl restart nginx","purpose":"Restart nginx","risk":"caution","risk_reason":"Restarts a running service","verification":{"kind":"service_active","service":"nginx; reboot"}}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"pwd\nwhoami","purpose":"Inspect environment","risk":"safe","risk_reason":"Reads the environment"}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"pwd","purpose":"Inspect directory","risk":"safe","risk_reason":"Reads the current directory","execute":true}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_terminal_command",
        r#"{"command":"pwd","purpose":"Inspect directory"}"#
    ));

    let definitions = tool_definitions(false, false, true);
    let names = definitions
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| value.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec!["propose_service_action", "propose_terminal_command"]
    );
    let command_schema = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["function"]["name"] == "propose_terminal_command")
        .unwrap();
    assert_eq!(
        command_schema["function"]["parameters"]["properties"]["command"]["pattern"],
        "^[^\\r\\n]+$"
    );
    assert!(valid_tool_arguments(
        "propose_service_action",
        r#"{"service":"nginx.service","action":"restart"}"#
    ));
    assert!(!valid_tool_arguments(
        "propose_service_action",
        r#"{"service":"nginx; reboot","action":"restart"}"#
    ));
    assert!(tool_allowed("propose_service_action", false, false, true));
    assert!(tool_allowed("propose_terminal_command", false, false, true));
    assert!(!tool_allowed(
        "propose_terminal_command",
        true,
        false,
        false
    ));

    let round = AiToolRound {
        calls: vec![AiToolCall {
            id: "call-command".to_string(),
            name: "propose_terminal_command".to_string(),
            arguments: arguments.to_string(),
        }],
        content: None,
        reasoning_content: None,
        results: vec![AiToolResult {
            call_id: "call-command".to_string(),
            name: "propose_terminal_command".to_string(),
            content: r#"{"ok":true,"proposalCaptured":true}"#.to_string(),
        }],
    };
    assert!(validate_tool_rounds(vec![round], false, false, true).is_ok());

    let messages = build_request_messages(
        vec![AiChatMessage {
            role: "user".to_string(),
            content: "Generate a command.".to_string(),
        }],
        None,
        false,
        false,
        true,
    );
    assert!(messages[0].content.contains("propose_terminal_command"));
    let fallback = build_request_messages(
        vec![AiChatMessage {
            role: "user".to_string(),
            content: "Generate a command.".to_string(),
        }],
        None,
        false,
        false,
        false,
    );
    assert!(!fallback[0].content.contains("propose_terminal_command"));
}

#[test]
fn turns_invalid_command_arguments_into_a_retryable_tool_round() {
    let calls = vec![
        AiToolCall {
            id: "call-invalid".to_string(),
            name: "propose_terminal_command".to_string(),
            arguments: r#"{"command":"printf ok\nprintf unsafe","purpose":"Write a script","risk":"caution","risk_reason":"Writes remote content"}"#.to_string(),
        },
        AiToolCall {
            id: "call-valid".to_string(),
            name: "propose_service_action".to_string(),
            arguments: r#"{"service":"nginx.service","action":"status"}"#.to_string(),
        },
    ];
    let round = invalid_tool_call_round(&calls, "I will inspect it.", None).unwrap();
    assert_eq!(round.calls.len(), 2);
    assert_eq!(round.results.len(), 2);
    let invalid = serde_json::from_str::<Value>(&round.results[0].content).unwrap();
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["retryable"], true);
    assert!(invalid["error"].as_str().unwrap().contains("单行命令"));
    let cancelled = serde_json::from_str::<Value>(&round.results[1].content).unwrap();
    assert_eq!(cancelled["ok"], false);
    assert!(cancelled["error"]
        .as_str()
        .unwrap()
        .contains("本调用未执行"));
}

#[test]
fn turns_mixed_diagnostic_and_action_calls_into_a_retryable_tool_round() {
    let calls = vec![
        AiToolCall {
            id: "call-status".to_string(),
            name: "get_server_status".to_string(),
            arguments: r#"{"reason":"Inspect current usage"}"#.to_string(),
        },
        AiToolCall {
            id: "call-command".to_string(),
            name: "propose_service_action".to_string(),
            arguments: r#"{"service":"nginx.service","action":"restart"}"#.to_string(),
        },
    ];

    let round = invalid_tool_call_round(&calls, "I will inspect and restart it.", None).unwrap();
    assert_eq!(round.calls.len(), calls.len());
    assert_eq!(round.calls[0].id, calls[0].id);
    assert_eq!(round.calls[1].id, calls[1].id);
    assert_eq!(round.results.len(), 2);
    for result in round.results {
        let value = serde_json::from_str::<Value>(&result.content).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["retryable"], true);
        assert!(value["error"]
            .as_str()
            .unwrap()
            .contains("不能同时包含诊断工具和操作提案"));
        assert!(value["instruction"]
            .as_str()
            .unwrap()
            .contains("never both"));
    }
}

#[test]
fn falls_back_only_when_a_provider_rejects_tool_calling() {
    assert!(is_tool_unsupported_error(
        400,
        "This model does not support tools"
    ));
    assert!(!is_tool_unsupported_error(401, "tools are unavailable"));
    assert!(!is_tool_unsupported_error(400, "model is missing"));
}

#[test]
fn classifies_only_explicit_capability_rejections_as_unsupported() {
    assert_eq!(
        capability_http_failure(
            AiCapabilityKind::Models,
            404,
            "models endpoint not found".to_string(),
        )
        .state,
        AiCapabilityState::Unsupported
    );
    assert_eq!(
        capability_http_failure(AiCapabilityKind::Models, 429, "rate limited".to_string(),).state,
        AiCapabilityState::Unknown
    );
    assert_eq!(
        capability_http_failure(
            AiCapabilityKind::Streaming,
            400,
            "stream is unsupported".to_string(),
        )
        .state,
        AiCapabilityState::Unsupported
    );
    assert_eq!(
        capability_http_failure(
            AiCapabilityKind::Streaming,
            500,
            "temporary failure".to_string(),
        )
        .state,
        AiCapabilityState::Unknown
    );
    assert_eq!(
        capability_http_failure(
            AiCapabilityKind::Tools,
            400,
            "model does not support tools".to_string(),
        )
        .state,
        AiCapabilityState::Unsupported
    );
    assert_eq!(
        capability_http_failure(
            AiCapabilityKind::Tools,
            400,
            "model is temporarily unavailable".to_string(),
        )
        .state,
        AiCapabilityState::Unknown
    );
}

#[test]
fn recognizes_standard_stream_and_tool_probe_responses() {
    assert!(valid_stream_probe_event("[DONE]").unwrap());
    assert!(valid_stream_probe_event(r#"{"choices":[{"delta":{"content":"OK"}}]}"#).unwrap());
    assert!(!valid_stream_probe_event(r#"{"choices":[]}"#).unwrap());
    assert!(tool_probe_supported(&serde_json::json!({
        "choices": [{
            "message": {
                "tool_calls": [{
                    "function": { "name": "fineshell_capability_probe" }
                }]
            }
        }]
    })));
    assert!(!tool_probe_supported(&serde_json::json!({
        "choices": [{ "message": { "content": "OK" } }]
    })));
}

#[test]
fn redacts_common_workspace_secrets() {
    let input = "api_key=secret\nworker --password process-secret\nAuthorization: Bearer token-value\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
    let sanitized = sanitize_context(input);
    assert!(!sanitized.contains("token-value"));
    assert!(!sanitized.contains("process-secret"));
    assert!(!sanitized.contains("\nsecret\n"));
    assert!(sanitized.contains("api_key=[REDACTED]"));
}

#[test]
fn wraps_workspace_context_as_untrusted_user_data() {
    let messages = build_request_messages(
        vec![AiChatMessage {
            role: "user".to_string(),
            content: "Analyze this host.".to_string(),
        }],
        Some("## Server status\npassword=secret"),
        true,
        false,
        false,
    );
    let user_message = messages.last().unwrap();
    assert!(user_message.content.contains("<workspace_context>"));
    assert!(user_message.content.contains("</workspace_context>"));
    assert!(user_message.content.contains("password=[REDACTED]"));
    assert!(!user_message.content.contains("password=secret"));
}
