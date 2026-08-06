use super::*;

#[tauri::command]
pub(crate) async fn ai_list_models(request: AiModelsRequest) -> CommandResult<Vec<AiModelInfo>> {
    let operation = "ai_list_models";
    let endpoint =
        service_endpoint(&request.base_url, "models").map_err(|e| structured(operation, e))?;
    let api_key = api_key_for_endpoint(&endpoint).map_err(|e| structured(operation, e))?;
    let request = client(Duration::from_secs(30))
        .map_err(|e| structured(operation, e))?
        .get(endpoint);
    let response = with_api_key(request, api_key.as_deref())
        .send()
        .await
        .map_err(|error| structured(operation, format!("无法获取模型列表：{error}")))?;
    if !response.status().is_success() {
        return Err(structured(operation, response_error(response).await));
    }
    let response = response
        .json::<AiModelsResponse>()
        .await
        .map_err(|error| structured(operation, format!("模型列表格式无效：{error}")))?;
    Ok(normalize_models(response.data))
}

#[tauri::command]
pub(crate) async fn ai_test_connection(request: AiConnectionRequest) -> CommandResult<()> {
    let operation = "ai_test_connection";
    let endpoint = service_endpoint(&request.base_url, "chat/completions")
        .map_err(|e| structured(operation, e))?;
    let model = validate_model(&request.model).map_err(|e| structured(operation, e))?;
    let api_key = api_key_for_endpoint(&endpoint).map_err(|e| structured(operation, e))?;
    let client = client(Duration::from_secs(30)).map_err(|e| structured(operation, e))?;
    test_basic_chat(&client, endpoint, api_key.as_deref(), model)
        .await
        .map_err(|e| structured(operation, e))
}

#[tauri::command]
pub(crate) async fn ai_probe_capabilities(
    request: AiConnectionRequest,
) -> CommandResult<AiServiceCapabilities> {
    let operation = "ai_probe_capabilities";
    let chat_endpoint = service_endpoint(&request.base_url, "chat/completions")
        .map_err(|e| structured(operation, e))?;
    let models_endpoint =
        service_endpoint(&request.base_url, "models").map_err(|e| structured(operation, e))?;
    let model = validate_model(&request.model).map_err(|e| structured(operation, e))?;
    let api_key = api_key_for_endpoint(&chat_endpoint).map_err(|e| structured(operation, e))?;
    let client = client(Duration::from_secs(30)).map_err(|e| structured(operation, e))?;

    test_basic_chat(&client, chat_endpoint.clone(), api_key.as_deref(), model)
        .await
        .map_err(|e| structured(operation, e))?;
    let (models, streaming, tools) = tokio::join!(
        probe_models(&client, models_endpoint, api_key.as_deref()),
        probe_streaming(&client, chat_endpoint.clone(), api_key.as_deref(), model),
        probe_tools(&client, chat_endpoint, api_key.as_deref(), model),
    );
    Ok(AiServiceCapabilities {
        chat: AiCapability::supported("基础对话请求成功"),
        models,
        streaming,
        tools,
    })
}

#[tauri::command]
pub(crate) async fn ai_chat_start(
    app: AppHandle,
    manager: State<'_, AiRequestManager>,
    task_manager: State<'_, AgentTaskManager>,
    ssh_manager: State<'_, SshSessionManager>,
    request: AiChatRequest,
) -> CommandResult<AiChatResult> {
    let operation = "ai_chat_start";
    if request.request_id.trim().is_empty() || request.request_id.len() > 160 {
        return Err(structured(operation, "AI 请求标识无效"));
    }
    let request_id = request.request_id.clone();
    let task_context = request.task.clone();
    if task_context
        .as_ref()
        .is_some_and(|task| task.id() != request_id)
    {
        return Err(structured(operation, "AI 任务标识与请求标识不一致"));
    }
    let endpoint = service_endpoint(&request.base_url, "chat/completions")
        .map_err(|error| structured(operation, error))?;
    let model = validate_model(&request.model)
        .map_err(|error| structured(operation, error))?
        .to_string();
    let request_messages =
        validate_messages(request.messages).map_err(|error| structured(operation, error))?;
    let enabled_tools = enabled_diagnostic_tools(request.enabled_tools, request.tools_enabled)
        .map_err(|error| structured(operation, error))?;
    let tools_enabled = !enabled_tools.is_empty();
    let file_edit_enabled = request.file_edit_enabled;
    let command_proposal_enabled = request.command_proposal_enabled;
    let any_tools_configured = tools_enabled || file_edit_enabled || command_proposal_enabled;
    let mut finalize_reason = None;
    let mut tool_rounds = validate_tool_rounds(
        request.tool_rounds,
        tools_enabled,
        file_edit_enabled,
        command_proposal_enabled,
    )
    .map_err(|error| structured(operation, error))?;
    validate_enabled_diagnostic_calls(&tool_rounds, &enabled_tools)
        .map_err(|error| structured(operation, error))?;
    let fallback_messages = build_request_messages(
        request_messages.clone(),
        request.context.as_deref(),
        false,
        false,
        false,
    );
    let api_key = api_key_for_endpoint(&endpoint).map_err(|error| structured(operation, error))?;
    let (cancel, mut cancellation) = watch::channel(false);
    {
        let mut requests = manager
            .cancellations
            .lock()
            .map_err(|_| structured(operation, "AI 请求状态不可用"))?;
        if requests.contains_key(&request_id) {
            return Err(structured(operation, "AI 请求已经存在"));
        }
        requests.insert(request_id.clone(), cancel);
    }

    let result = async {
        let ai_client =
            client(Duration::from_secs(180)).map_err(|error| structured(operation, error))?;
        let mut runtime_plans = Vec::new();
        let mut runtime_rounds = Vec::new();

        loop {
            if *cancellation.borrow() {
                return Err(structured(operation, "AI 请求已取消"));
            }
            if let Some(context) = task_context.as_ref() {
                let events = task_manager
                    .begin_model_turn(context)
                    .map_err(|error| structured(operation, error))?;
                agent::emit_task_events(&app, events);
            }

            let mut messages = build_request_messages(
                request_messages.clone(),
                request.context.as_deref(),
                tools_enabled,
                file_edit_enabled,
                command_proposal_enabled,
            );
            if let Some(reason) = finalize_reason {
                apply_finalization_instruction_to_chat(&mut messages, reason);
            }
            let allow_tool_fallback = tool_rounds.is_empty();
            let mut response = request_ai_turn(AiTurnOptions {
                app: &app,
                request_id: &request_id,
                client: &ai_client,
                base_url: &request.base_url,
                api_key: api_key.as_deref(),
                model: &model,
                messages,
                fallback_messages: fallback_messages.clone(),
                tool_rounds: &tool_rounds,
                any_tools_enabled: any_tools_configured && finalize_reason.is_none(),
                tools_enabled,
                file_edit_enabled,
                command_proposal_enabled,
                enabled_tools: &enabled_tools,
                allow_tool_fallback,
                finalize_reason,
                cancellation: &mut cancellation,
            })
            .await?;

            if !response.tool_calls.is_empty() {
                if let Some(reason) = tool_loop_finalize_reason(&tool_rounds, &response.tool_calls)
                {
                    if let Some(context) = task_context.as_ref() {
                        let events = task_manager
                            .finish_model_turn(context.id(), true)
                            .map_err(|error| structured(operation, error))?;
                        agent::emit_task_events(&app, events);
                    }
                    finalize_reason = Some(reason);
                    continue;
                }
            }

            response.action_intents = response
                .tool_calls
                .iter()
                .map(|call| proposal_action_intent(&call.id, &call.name, &call.arguments))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| structured(operation, error))?
                .into_iter()
                .flatten()
                .collect();
            if let Some(context) = task_context.as_ref() {
                let events = task_manager
                    .register_actions(context.id(), response.action_intents.clone())
                    .map_err(|error| structured(operation, error))?;
                agent::emit_task_events(&app, events);
            }

            let diagnostic_only = !response.tool_calls.is_empty()
                && response
                    .tool_calls
                    .iter()
                    .all(|call| diagnostic_tool(&call.name));
            if diagnostic_only && task_context.is_some() {
                if let Some(context) = task_context.as_ref() {
                    let events = task_manager
                        .finish_model_turn(&request_id, true)
                        .map_err(|error| structured(operation, error))?;
                    agent::emit_task_events(&app, events);

                    let mut plan = create_diagnostic_plan(
                        &response.tool_calls,
                        &response.content,
                        runtime_plans.len().saturating_add(1),
                    );
                    let policy_evaluations = diagnostic_policy_evaluations(
                        context,
                        &enabled_tools,
                        &response.tool_calls,
                    );
                    apply_policy_to_plan(&mut plan, &policy_evaluations);
                    let approval_requirements = response
                        .tool_calls
                        .iter()
                        .filter(|call| {
                            policy_evaluations.get(&call.id).is_some_and(|evaluation| {
                                evaluation.decision == PolicyDecision::Prompt
                            })
                        })
                        .map(|call| {
                            action_fingerprint(
                                &call.name,
                                &Value::Object(diagnostic_arguments(call)),
                            )
                            .map(|fingerprint| (call.id.clone(), fingerprint))
                        })
                        .collect::<Result<HashMap<_, _>, _>>()
                        .map_err(|error| structured(operation, error))?;
                    let (mut decision_receiver, events) = task_manager
                        .set_plan(&request_id, plan.clone(), approval_requirements)
                        .map_err(|error| structured(operation, error))?;
                    agent::emit_task_events(&app, events);
                    let decision =
                        wait_for_plan_decision(&mut decision_receiver, &mut cancellation)
                            .await
                            .map_err(|error| structured(operation, error))?;
                    let calls = response.tool_calls.clone();
                    let (completed_plan, results) = execute_diagnostic_plan(
                        DiagnosticPlanExecution {
                            app: &app,
                            task_manager: &task_manager,
                            ssh_manager: &ssh_manager,
                            context,
                            calls: &calls,
                            policies: &policy_evaluations,
                            plan_control: &decision_receiver,
                            cancellation: &mut cancellation,
                        },
                        plan,
                        decision,
                    )
                    .await
                    .map_err(|error| structured(operation, error))?;
                    let round = AiToolRound {
                        calls,
                        content: (!response.content.trim().is_empty())
                            .then(|| response.content.trim().to_string()),
                        reasoning_content: response.reasoning_content.clone(),
                        results,
                    };
                    tool_rounds.push(round.clone());
                    runtime_rounds.push(round);
                    runtime_plans.push(completed_plan);
                    continue;
                }
            }

            if let Some(context) = task_context.as_ref() {
                let events = task_manager
                    .finish_model_turn(context.id(), !response.tool_calls.is_empty())
                    .map_err(|error| structured(operation, error))?;
                agent::emit_task_events(&app, events);
            }
            response.diagnostic_plans = runtime_plans;
            response.diagnostic_tool_rounds = runtime_rounds;
            return Ok(response);
        }
    }
    .await;

    task_manager.clear_plan_control(&request_id);
    if let Ok(mut requests) = manager.cancellations.lock() {
        requests.remove(&request_id);
    }
    if task_context.is_some() && result.is_err() {
        if let Ok(events) = task_manager.fail_task(&request_id, "AI 模型或诊断请求失败") {
            agent::emit_task_events(&app, events);
        }
    }
    if result.is_ok() {
        let _ = app.emit_to(
            "main",
            AI_COMPLETE_EVENT,
            AiCompletePayload {
                request_id: request_id.clone(),
            },
        );
    }
    result
}
#[tauri::command]
pub(crate) fn ai_chat_cancel(
    app: AppHandle,
    manager: State<'_, AiRequestManager>,
    task_manager: State<'_, AgentTaskManager>,
    ssh_manager: State<'_, SshSessionManager>,
    request_id: String,
) -> CommandResult<()> {
    let operation = "ai_chat_cancel";
    {
        let requests = manager
            .cancellations
            .lock()
            .map_err(|_| structured(operation, "AI 请求状态不可用"))?;
        if let Some(cancellation) = requests.get(&request_id) {
            let _ = cancellation.send(true);
        }
    }
    ssh_manager.cancel_agent_commands(&request_id);
    let events = task_manager
        .cancel_task(&request_id)
        .map_err(|error| structured(operation, error))?;
    agent::emit_task_events(&app, events);
    Ok(())
}
