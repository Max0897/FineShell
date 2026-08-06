use super::*;

pub(super) struct AiTurnOptions<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) request_id: &'a str,
    pub(super) client: &'a Client,
    pub(super) base_url: &'a str,
    pub(super) api_key: Option<&'a str>,
    pub(super) model: &'a str,
    pub(super) messages: Vec<AiChatMessage>,
    pub(super) fallback_messages: Vec<AiChatMessage>,
    pub(super) tool_rounds: &'a [AiToolRound],
    pub(super) any_tools_enabled: bool,
    pub(super) tools_enabled: bool,
    pub(super) file_edit_enabled: bool,
    pub(super) command_proposal_enabled: bool,
    pub(super) enabled_tools: &'a HashSet<String>,
    pub(super) allow_tool_fallback: bool,
    pub(super) finalize_reason: Option<AiFinalizeReason>,
    pub(super) cancellation: &'a mut watch::Receiver<bool>,
}

pub(super) async fn request_ai_turn(options: AiTurnOptions<'_>) -> CommandResult<AiChatResult> {
    let operation = "ai_chat_start";
    let started_at = Instant::now();
    let mut failed_provider_attempts = 0_u32;
    let definitions = if options.any_tools_enabled {
        filter_tool_definitions(
            tool_definitions(
                options.tools_enabled,
                options.file_edit_enabled,
                options.command_proposal_enabled,
            ),
            options.enabled_tools,
        )
    } else {
        Value::Array(Vec::new())
    };
    let request = ProviderTurnRequest {
        app: options.app,
        request_id: options.request_id,
        client: options.client,
        base_url: options.base_url,
        api_key: options.api_key,
        model: options.model,
        messages: options.messages,
        tool_rounds: options.tool_rounds,
        tool_definitions: definitions,
        cancellation: options.cancellation,
    };
    let response = match request_provider_turn(request).await {
        Ok(response) => response,
        Err(error)
            if options.any_tools_enabled
                && options.allow_tool_fallback
                && error.is_tool_unsupported() =>
        {
            failed_provider_attempts = failed_provider_attempts.saturating_add(1);
            request_provider_turn(ProviderTurnRequest {
                app: options.app,
                request_id: options.request_id,
                client: options.client,
                base_url: options.base_url,
                api_key: options.api_key,
                model: options.model,
                messages: options.fallback_messages,
                tool_rounds: &[],
                tool_definitions: Value::Array(Vec::new()),
                cancellation: options.cancellation,
            })
            .await
            .map_err(|error| structured(operation, error.message))?
        }
        Err(error) => return Err(structured(operation, error.message)),
    };
    let content = response.content;
    let reasoning_content = response.reasoning_content;
    let tool_calls = response.tool_calls;
    if content.chars().count() > MAX_RESPONSE_CHARS {
        return Err(structured(operation, "AI 响应内容过长"));
    }
    if reasoning_content
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_REASONING_CONTENT_CHARS)
    {
        return Err(structured(operation, "AI 推理内容过长"));
    }
    if options.finalize_reason.is_some() && !tool_calls.is_empty() {
        return Err(structured(operation, "AI 收尾响应不应包含工具调用"));
    }
    if tool_calls.iter().any(|call| {
        !tool_allowed(
            &call.name,
            options.tools_enabled,
            options.file_edit_enabled,
            options.command_proposal_enabled,
        ) || (diagnostic_tool(&call.name) && !options.enabled_tools.contains(&call.name))
    }) {
        return Err(structured(operation, "AI 返回了未启用的工具调用"));
    }
    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err(structured(operation, "AI 服务没有返回内容"));
    }
    Ok(AiChatResult {
        content,
        reasoning_content,
        tool_calls,
        action_intents: Vec::new(),
        diagnostic_plans: Vec::new(),
        diagnostic_tool_rounds: Vec::new(),
        telemetry: AiRequestTelemetry {
            duration_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            request_count: response
                .request_count
                .saturating_add(failed_provider_attempts),
            usage: response.usage,
        },
    })
}
