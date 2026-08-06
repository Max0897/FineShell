use super::*;

pub(super) fn diagnostic_tool_label(name: &str) -> &'static str {
    match name {
        "get_server_status" => "读取服务器状态",
        "list_processes" => "读取进程列表",
        "get_current_directory" => "读取当前目录",
        "inspect_service" => "检查服务状态",
        "read_service_logs" => "读取服务日志",
        "get_network_connections" => "读取网络连接",
        "ping_target" => "Ping",
        "trace_route" => "路由追踪",
        _ => "未知只读工具",
    }
}

pub(super) fn diagnostic_arguments(call: &AiToolCall) -> serde_json::Map<String, Value> {
    serde_json::from_str::<Value>(&call.arguments)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

pub(super) fn create_diagnostic_plan(
    calls: &[AiToolCall],
    description: &str,
    ordinal: usize,
) -> AgentPlan {
    let steps = calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let arguments = diagnostic_arguments(call);
            let detail = arguments
                .get("target")
                .or_else(|| arguments.get("service"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let reason = arguments
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| sanitize_context(value).chars().take(240).collect())
                .unwrap_or_else(|| {
                    detail.as_ref().map_or_else(
                        || diagnostic_tool_label(&call.name).to_string(),
                        |target| format!("{} {target}", diagnostic_tool_label(&call.name)),
                    )
                });
            let depends_on = arguments
                .get("depends_on")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .filter_map(|dependency| {
                    usize::try_from(dependency)
                        .ok()
                        .and_then(|dependency| dependency.checked_sub(1))
                        .filter(|dependency| *dependency < index)
                        .and_then(|dependency| calls.get(dependency))
                        .map(|dependency| dependency.id.clone())
                })
                .collect();
            AgentPlanStep {
                id: call.id.clone(),
                title: diagnostic_tool_label(&call.name).to_string(),
                tool: call.name.clone(),
                status: AgentPlanStepStatus::Pending,
                detail,
                reason,
                optional: arguments
                    .get("optional")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                depends_on,
                summary: matches!(call.name.as_str(), "ping_target" | "trace_route")
                    .then(|| "确认计划即授权执行此主动网络探测".to_string()),
                error: None,
                started_at: None,
                duration_ms: None,
            }
        })
        .collect();
    AgentPlan {
        id: format!("agent-plan-{}-{ordinal}", timestamp_ms()),
        description: (!description.trim().is_empty()).then(|| {
            sanitize_context(description.trim())
                .chars()
                .take(2_000)
                .collect()
        }),
        status: AgentPlanStatus::Pending,
        created_at: timestamp_ms(),
        steps,
    }
}

pub(super) fn diagnostic_policy_evaluations(
    context: &AgentTaskContext,
    enabled_tools: &HashSet<String>,
    calls: &[AiToolCall],
) -> HashMap<String, PolicyEvaluation> {
    let boundary = ExecutionBoundary::new(
        context.id(),
        context.host_id(),
        context.terminal_session_id(),
        context.current_directory(),
        enabled_tools,
    );
    calls
        .iter()
        .map(|call| {
            (
                call.id.clone(),
                boundary.evaluate(
                    context.approval_mode(),
                    &call.name,
                    &Value::Object(diagnostic_arguments(call)),
                ),
            )
        })
        .collect()
}

pub(super) fn policy_risk_label(risk: crate::agent::AgentActionRisk) -> &'static str {
    match risk {
        crate::agent::AgentActionRisk::ReadOnly => "只读",
        crate::agent::AgentActionRisk::LowRisk => "低风险",
        crate::agent::AgentActionRisk::ReversibleWrite => "可逆写入",
        crate::agent::AgentActionRisk::Elevated => "高权限",
        crate::agent::AgentActionRisk::Critical => "关键操作",
    }
}

pub(super) fn apply_policy_to_plan(
    plan: &mut AgentPlan,
    evaluations: &HashMap<String, PolicyEvaluation>,
) {
    for step in &mut plan.steps {
        let Some(evaluation) = evaluations.get(&step.id) else {
            continue;
        };
        match evaluation.decision {
            PolicyDecision::Allow => {}
            PolicyDecision::Prompt => {
                step.summary = Some(format!(
                    "{} · {}",
                    policy_risk_label(evaluation.risk),
                    evaluation.reason
                ));
            }
            PolicyDecision::Deny => {
                step.error = Some(evaluation.reason.clone());
                step.summary = Some(evaluation.reason.clone());
            }
        }
    }
}

pub(super) fn tool_error_result(call: &AiToolCall, error: &str) -> AiToolResult {
    AiToolResult {
        call_id: call.id.clone(),
        name: call.name.clone(),
        content: json!({
            "ok": false,
            "error": sanitize_context(error).chars().take(300).collect::<String>(),
        })
        .to_string(),
    }
}

pub(super) fn bounded_serialized_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "诊断结果无法序列化".to_string())
}

pub(super) fn insert_ok(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    value
}

pub(super) fn server_status_value(value: Value) -> Value {
    json!({
        "ok": true,
        "hostname": value.get("hostname"),
        "operatingSystem": value.get("operatingSystem"),
        "kernel": value.get("kernel"),
        "uptimeSeconds": value.get("uptimeSeconds"),
        "loadAverage": value.get("loadAverage"),
        "cpuUsagePercent": value.get("cpuUsagePercent"),
        "memory": {
            "usedBytes": value.get("memoryUsedBytes"),
            "totalBytes": value.get("memoryTotalBytes"),
            "usagePercent": value.get("memoryUsagePercent"),
        },
        "disk": {
            "usedBytes": value.get("diskUsedBytes"),
            "totalBytes": value.get("diskTotalBytes"),
            "usagePercent": value.get("diskUsagePercent"),
        },
        "network": {
            "receivedBytes": value.get("networkReceiveBytes"),
            "transmittedBytes": value.get("networkTransmitBytes"),
        },
    })
}

pub(super) fn process_list_value(mut value: Value) -> Value {
    let truncated_by_source = value
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut processes = value
        .get_mut("processes")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default();
    let total = processes.len();
    processes.truncate(15);
    for process in &mut processes {
        if let Some(object) = process.as_object_mut() {
            object.remove("id");
            if let Some(command) = object
                .get("command")
                .and_then(Value::as_str)
                .map(|command| command.chars().take(300).collect())
            {
                object.insert("command".to_string(), Value::String(command));
            }
        }
    }
    json!({
        "ok": true,
        "total": total,
        "returned": processes.len(),
        "truncated": truncated_by_source || processes.len() < total,
        "processes": processes,
    })
}

pub(super) fn network_connections_value(mut value: Value) -> Value {
    let truncated_by_source = value
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut connections = value
        .get_mut("connections")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default();
    let total = connections.len();
    connections.truncate(40);
    for connection in &mut connections {
        if let Some(object) = connection.as_object_mut() {
            object.remove("id");
            if let Some(process) = object
                .get("process")
                .and_then(Value::as_str)
                .map(|process| process.chars().take(200).collect())
            {
                object.insert("process".to_string(), Value::String(process));
            }
        }
    }
    json!({
        "ok": true,
        "total": total,
        "returned": connections.len(),
        "truncated": truncated_by_source || connections.len() < total,
        "connections": connections,
    })
}

pub(super) fn trace_route_value(mut value: Value) -> Value {
    if let Some(hops) = value.get_mut("hops").and_then(Value::as_array_mut) {
        hops.truncate(12);
    }
    insert_ok(value)
}

pub(super) fn tool_summary(call: &AiToolCall, value: &Value) -> String {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("诊断未完成")
            .to_string();
    }
    match call.name.as_str() {
        "get_server_status" => "已读取服务器状态".to_string(),
        "list_processes" => format!(
            "已返回 {} 个进程",
            value.get("returned").and_then(Value::as_u64).unwrap_or(0)
        ),
        "get_current_directory" => format!(
            "当前目录：{}",
            value.get("path").and_then(Value::as_str).unwrap_or("-")
        ),
        "inspect_service" => format!(
            "{}：{} / {}",
            value.get("service").and_then(Value::as_str).unwrap_or("-"),
            value
                .get("activeState")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            value
                .get("subState")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        "read_service_logs" => format!(
            "已读取 {} 的最近 {} 行日志",
            value.get("service").and_then(Value::as_str).unwrap_or("-"),
            value.get("lines").and_then(Value::as_u64).unwrap_or(0)
        ),
        "get_network_connections" => format!(
            "已返回 {} 条网络连接",
            value.get("returned").and_then(Value::as_u64).unwrap_or(0)
        ),
        "ping_target" => format!(
            "Ping {}：{}",
            value.get("target").and_then(Value::as_str).unwrap_or("-"),
            if value.get("reachable").and_then(Value::as_bool) == Some(true) {
                "可达"
            } else {
                "不可达"
            }
        ),
        "trace_route" => format!(
            "路由追踪 {}：{}",
            value.get("target").and_then(Value::as_str).unwrap_or("-"),
            if value.get("reached").and_then(Value::as_bool) == Some(true) {
                "已到达"
            } else {
                "未到达"
            }
        ),
        _ => "诊断已完成".to_string(),
    }
}

pub(super) async fn execute_diagnostic_tool(
    ssh_manager: &SshSessionManager,
    context: &AgentTaskContext,
    call: &AiToolCall,
) -> Result<Value, String> {
    let session_id = context
        .terminal_session_id()
        .ok_or_else(|| "当前终端会话不可用".to_string())?;
    match call.name.as_str() {
        "get_server_status" => ssh_manager
            .monitor_snapshot(session_id)
            .await
            .and_then(bounded_serialized_value)
            .map(server_status_value),
        "list_processes" => ssh_manager
            .processes(session_id)
            .await
            .and_then(bounded_serialized_value)
            .map(process_list_value),
        "get_current_directory" => context
            .current_directory()
            .filter(|path| !path.trim().is_empty())
            .map(|path| json!({ "ok": true, "path": path }))
            .ok_or_else(|| "SFTP 当前目录尚不可用".to_string()),
        "get_network_connections" => ssh_manager
            .network_connections(session_id)
            .await
            .and_then(bounded_serialized_value)
            .map(network_connections_value),
        "inspect_service" => {
            let service = diagnostic_arguments(call)
                .get("service")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 未提供服务名称".to_string())?
                .to_string();
            ssh_manager
                .inspect_service(session_id, service)
                .await
                .and_then(bounded_serialized_value)
                .map(insert_ok)
        }
        "read_service_logs" => {
            let arguments = diagnostic_arguments(call);
            let service = arguments
                .get("service")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 未提供服务名称".to_string())?
                .to_string();
            let lines = arguments
                .get("lines")
                .and_then(Value::as_u64)
                .unwrap_or(100) as u16;
            ssh_manager
                .service_logs(session_id, service, lines)
                .await
                .and_then(bounded_serialized_value)
                .map(insert_ok)
        }
        "ping_target" => {
            let target = diagnostic_arguments(call)
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 未提供 Ping 目标".to_string())?
                .to_string();
            ssh_manager
                .ping(session_id, target)
                .await
                .and_then(bounded_serialized_value)
                .map(insert_ok)
        }
        "trace_route" => {
            let target = diagnostic_arguments(call)
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 未提供路由追踪目标".to_string())?
                .to_string();
            ssh_manager
                .trace_route(session_id, target)
                .await
                .and_then(bounded_serialized_value)
                .map(trace_route_value)
        }
        _ => Err("AI 请求了不支持的只读工具".to_string()),
    }
}

pub(super) enum DiagnosticExecutionError {
    Tool(String),
    Interrupted(String),
}

pub(super) fn diagnostic_tool_requires_connection(tool: &str) -> bool {
    tool != "get_current_directory"
}

pub(super) async fn wait_for_reconnected_session(
    app: &AppHandle,
    task_manager: &AgentTaskManager,
    ssh_manager: &SshSessionManager,
    context: &AgentTaskContext,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let session_id = context
        .terminal_session_id()
        .ok_or_else(|| "当前终端会话不可用".to_string())?;
    if ssh_manager.is_connected(session_id)? {
        return Ok(());
    }

    agent::emit_task_events(
        app,
        task_manager.pause_disconnected(context.id(), "SSH 连接已断开，等待同一会话重连")?,
    );
    let started = Instant::now();
    loop {
        if *cancellation.borrow() {
            return Err("AI 请求已取消".to_string());
        }
        if ssh_manager.is_connected(session_id)? {
            agent::emit_task_events(app, task_manager.resume_disconnected(context.id())?);
            return Ok(());
        }
        if started.elapsed() >= SSH_RECONNECT_TIMEOUT {
            return Err("等待 SSH 会话重连超时".to_string());
        }
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_ok() && *cancellation.borrow() {
                    return Err("AI 请求已取消".to_string());
                }
            }
            _ = tokio::time::sleep(SSH_RECONNECT_POLL_INTERVAL) => {}
        }
    }
}

pub(super) async fn execute_diagnostic_tool_with_recovery(
    app: &AppHandle,
    task_manager: &AgentTaskManager,
    ssh_manager: &SshSessionManager,
    context: &AgentTaskContext,
    call: &AiToolCall,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<Value, DiagnosticExecutionError> {
    if !diagnostic_tool_requires_connection(&call.name) {
        return execute_diagnostic_tool(ssh_manager, context, call)
            .await
            .map_err(DiagnosticExecutionError::Tool);
    }
    let session_id = context
        .terminal_session_id()
        .ok_or_else(|| DiagnosticExecutionError::Tool("当前终端会话不可用".to_string()))?;

    loop {
        wait_for_reconnected_session(app, task_manager, ssh_manager, context, cancellation)
            .await
            .map_err(DiagnosticExecutionError::Interrupted)?;
        match execute_diagnostic_tool(ssh_manager, context, call).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                // The SSH worker removes a stopped session immediately. Give it one
                // scheduling turn to publish that state before classifying a tool error.
                tokio::time::sleep(Duration::from_millis(25)).await;
                if ssh_manager
                    .is_connected(session_id)
                    .map_err(DiagnosticExecutionError::Interrupted)?
                {
                    return Err(DiagnosticExecutionError::Tool(error));
                }
            }
        }
    }
}

pub(super) async fn wait_for_plan_decision(
    decision: &mut watch::Receiver<AgentPlanDecision>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<AgentPlanDecision, String> {
    if *cancellation.borrow() {
        return Err("AI 请求已取消".to_string());
    }
    if *decision.borrow() != AgentPlanDecision::Pending {
        return Ok(decision.borrow().clone());
    }
    tokio::select! {
        result = decision.changed() => {
            result.map_err(|_| "AI 计划已经结束".to_string())?;
            Ok(decision.borrow().clone())
        }
        result = cancellation.changed() => {
            if result.is_ok() && *cancellation.borrow() {
                Err("AI 请求已取消".to_string())
            } else {
                Err("AI 请求状态不可用".to_string())
            }
        }
        _ = tokio::time::sleep(PLAN_APPROVAL_TIMEOUT) => {
            Ok(AgentPlanDecision::Reject(None))
        }
    }
}

pub(super) fn final_plan_status(plan: &AgentPlan) -> AgentPlanStatus {
    let completed = plan
        .steps
        .iter()
        .filter(|step| step.status == AgentPlanStepStatus::Completed)
        .count();
    if plan.steps.iter().all(|step| {
        step.status == AgentPlanStepStatus::Completed
            || (step.optional && step.status == AgentPlanStepStatus::Skipped)
    }) {
        AgentPlanStatus::Completed
    } else if completed > 0
        || plan
            .steps
            .iter()
            .any(|step| step.status == AgentPlanStepStatus::Failed)
    {
        AgentPlanStatus::Partial
    } else {
        AgentPlanStatus::Cancelled
    }
}

pub(super) struct DiagnosticPlanExecution<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) task_manager: &'a AgentTaskManager,
    pub(super) ssh_manager: &'a SshSessionManager,
    pub(super) context: &'a AgentTaskContext,
    pub(super) calls: &'a [AiToolCall],
    pub(super) policies: &'a HashMap<String, PolicyEvaluation>,
    pub(super) plan_control: &'a watch::Receiver<AgentPlanDecision>,
    pub(super) cancellation: &'a mut watch::Receiver<bool>,
}

pub(super) async fn execute_diagnostic_plan(
    execution: DiagnosticPlanExecution<'_>,
    mut plan: AgentPlan,
    decision: AgentPlanDecision,
) -> Result<(AgentPlan, Vec<AiToolResult>), String> {
    let DiagnosticPlanExecution {
        app,
        task_manager,
        ssh_manager,
        context,
        calls,
        policies,
        plan_control,
        cancellation,
    } = execution;
    let approval = match &decision {
        AgentPlanDecision::Approve(approval) => Some(approval),
        AgentPlanDecision::Reject(_) | AgentPlanDecision::Stop => None,
        AgentPlanDecision::Pending => return Err("AI 计划尚未获得决定".to_string()),
    };
    let selected = match approval {
        Some(approval) => approval
            .selected_call_ids()
            .iter()
            .cloned()
            .collect::<HashSet<_>>(),
        None => HashSet::new(),
    };
    plan.status = AgentPlanStatus::Running;
    agent::emit_task_events(app, task_manager.start_plan(context.id(), plan.clone())?);
    let mut results = Vec::with_capacity(calls.len());
    for (index, call) in calls.iter().enumerate() {
        let policy = policies
            .get(&call.id)
            .ok_or_else(|| "诊断动作缺少后端策略结果".to_string())?;
        let dependency_failed = plan.steps[index].depends_on.iter().any(|dependency| {
            plan.steps
                .iter()
                .find(|step| step.id == *dependency)
                .is_none_or(|step| step.status != AgentPlanStepStatus::Completed)
        });
        let should_execute = !matches!(
            &decision,
            AgentPlanDecision::Reject(_) | AgentPlanDecision::Stop
        ) && policy.decision != PolicyDecision::Deny
            && (!plan.steps[index].optional || selected.contains(&call.id));
        let stop_requested = matches!(&*plan_control.borrow(), AgentPlanDecision::Stop);
        let mut skip_reason = if let AgentPlanDecision::Reject(feedback) = &decision {
            Some((
                feedback
                    .as_ref()
                    .map(|feedback| format!("用户拒绝了当前操作。附加要求：{feedback}"))
                    .unwrap_or_else(|| "用户拒绝了当前操作".to_string()),
                false,
            ))
        } else if matches!(decision, AgentPlanDecision::Stop)
            || stop_requested
            || *cancellation.borrow()
        {
            Some(("用户停止了剩余诊断步骤".to_string(), false))
        } else if policy.decision == PolicyDecision::Deny {
            Some((policy.reason.clone(), true))
        } else if policy.decision == PolicyDecision::Prompt && !selected.contains(&call.id) {
            Some(("该诊断动作未获得本次审批".to_string(), false))
        } else if !should_execute {
            Some(("用户取消了可选诊断步骤".to_string(), false))
        } else if dependency_failed {
            Some(("依赖的诊断步骤未成功，已跳过".to_string(), false))
        } else {
            None
        };
        if skip_reason.is_none() && policy.decision == PolicyDecision::Prompt {
            let result = approval
                .and_then(|approval| approval.credential_for(&call.id))
                .ok_or_else(|| "该诊断动作缺少一次性审批凭证".to_string())
                .and_then(|credential| {
                    action_fingerprint(&call.name, &Value::Object(diagnostic_arguments(call)))
                        .and_then(|fingerprint| {
                            task_manager.consume_approval(
                                credential,
                                ApprovalScope {
                                    task_id: context.id().to_string(),
                                    plan_id: plan.id.clone(),
                                    call_id: call.id.clone(),
                                    host_id: context.host_id().to_string(),
                                    session_id: context.terminal_session_id().map(str::to_string),
                                    current_directory: context
                                        .current_directory()
                                        .map(str::to_string),
                                    action_fingerprint: fingerprint,
                                },
                            )
                        })
                });
            if let Err(error) = result {
                skip_reason = Some((error, true));
            }
        }
        if let Some((reason, failed)) = skip_reason {
            let step = &mut plan.steps[index];
            step.status = if failed {
                AgentPlanStepStatus::Failed
            } else {
                AgentPlanStepStatus::Skipped
            };
            step.error = Some(reason.clone());
            step.summary = Some(reason.clone());
            step.started_at = Some(timestamp_ms());
            step.duration_ms = Some(0);
            results.push(tool_error_result(call, &reason));
            agent::emit_task_events(
                app,
                task_manager.update_plan(context.id(), plan.clone(), false)?,
            );
            continue;
        }

        let started_at = timestamp_ms();
        let started = Instant::now();
        plan.steps[index].status = AgentPlanStepStatus::InProgress;
        plan.steps[index].started_at = Some(started_at);
        plan.steps[index].summary = None;
        agent::emit_task_events(
            app,
            task_manager.update_plan(context.id(), plan.clone(), false)?,
        );
        let execution = execute_diagnostic_tool_with_recovery(
            app,
            task_manager,
            ssh_manager,
            context,
            call,
            cancellation,
        )
        .await;
        let duration_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
        match execution {
            Ok(value) => {
                plan.steps[index].status = AgentPlanStepStatus::Completed;
                plan.steps[index].summary = Some(tool_summary(call, &value));
                plan.steps[index].error = None;
                results.push(AiToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: sanitize_context(&value.to_string()),
                });
            }
            Err(DiagnosticExecutionError::Tool(error)) => {
                let error = sanitize_context(&error)
                    .chars()
                    .take(300)
                    .collect::<String>();
                plan.steps[index].status = AgentPlanStepStatus::Failed;
                plan.steps[index].summary = Some(error.clone());
                plan.steps[index].error = Some(error.clone());
                results.push(tool_error_result(call, &error));
            }
            Err(DiagnosticExecutionError::Interrupted(error)) => {
                let error = sanitize_context(&error)
                    .chars()
                    .take(300)
                    .collect::<String>();
                plan.steps[index].status = AgentPlanStepStatus::Failed;
                plan.steps[index].summary = Some(error.clone());
                plan.steps[index].error = Some(error.clone());
                plan.steps[index].duration_ms = Some(duration_ms);
                agent::emit_task_events(
                    app,
                    task_manager.update_plan(context.id(), plan.clone(), false)?,
                );
                return Err(error);
            }
        }
        plan.steps[index].duration_ms = Some(duration_ms);
        agent::emit_task_events(
            app,
            task_manager.update_plan(context.id(), plan.clone(), false)?,
        );
    }
    plan.status = final_plan_status(&plan);
    agent::emit_task_events(
        app,
        task_manager.update_plan(context.id(), plan.clone(), true)?,
    );
    task_manager.clear_plan_control(context.id());
    Ok((plan, results))
}
