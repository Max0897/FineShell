use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProviderErrorKind {
    Authentication,
    RateLimited,
    ToolUnsupported,
    Service,
    Protocol,
}

pub(super) struct ProviderTurnRequest<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) request_id: &'a str,
    pub(super) client: &'a Client,
    pub(super) base_url: &'a str,
    pub(super) api_key: Option<&'a str>,
    pub(super) model: &'a str,
    pub(super) messages: Vec<AiChatMessage>,
    pub(super) tool_rounds: &'a [AiToolRound],
    pub(super) tool_definitions: Value,
    pub(super) cancellation: &'a mut watch::Receiver<bool>,
}

pub(super) struct ProviderTurnResult {
    pub(super) content: String,
    pub(super) reasoning_content: Option<String>,
    pub(super) tool_calls: Vec<AiToolCall>,
    pub(super) request_count: u32,
    pub(super) usage: Option<AiTokenUsage>,
}

#[derive(Debug)]
pub(super) struct ProviderTurnError {
    pub(super) message: String,
    pub(super) kind: ProviderErrorKind,
}

impl ProviderTurnError {
    fn from_rig(error: crate::ai_rig::RigTurnError) -> Self {
        let kind = classify_provider_error(error.status, &error.message);
        Self {
            message: error.message,
            kind,
        }
    }

    pub(super) fn is_tool_unsupported(&self) -> bool {
        self.kind == ProviderErrorKind::ToolUnsupported
    }
}

fn classify_provider_error(status: Option<u16>, message: &str) -> ProviderErrorKind {
    match status {
        Some(401 | 403) => ProviderErrorKind::Authentication,
        Some(429) => ProviderErrorKind::RateLimited,
        Some(status) if is_tool_unsupported_error(status, message) => {
            ProviderErrorKind::ToolUnsupported
        }
        Some(_) => ProviderErrorKind::Service,
        None => ProviderErrorKind::Protocol,
    }
}

pub(super) async fn request_provider_turn(
    request: ProviderTurnRequest<'_>,
) -> Result<ProviderTurnResult, ProviderTurnError> {
    OpenAiCompatibleProvider::request_turn(request).await
}

struct OpenAiCompatibleProvider;

impl OpenAiCompatibleProvider {
    async fn request_turn(
        request: ProviderTurnRequest<'_>,
    ) -> Result<ProviderTurnResult, ProviderTurnError> {
        let tools =
            crate::ai_rig::tool_definitions(request.tool_definitions).map_err(|message| {
                ProviderTurnError {
                    message,
                    kind: ProviderErrorKind::Protocol,
                }
            })?;
        crate::ai_rig::request_turn(crate::ai_rig::RigTurnRequest {
            app: request.app,
            request_id: request.request_id,
            client: request.client,
            base_url: request.base_url,
            api_key: request.api_key,
            model: request.model,
            messages: request.messages,
            tool_rounds: request.tool_rounds,
            tools,
            cancellation: request.cancellation,
        })
        .await
        .map(|response| ProviderTurnResult {
            content: response.content,
            reasoning_content: response.reasoning_content,
            tool_calls: response.tool_calls,
            request_count: response.request_count,
            usage: response.usage.map(|usage| AiTokenUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                reasoning_tokens: usage.reasoning_tokens,
            }),
        })
        .map_err(ProviderTurnError::from_rig)
    }
}

pub(super) fn structured(operation: &'static str, error: impl Into<String>) -> CommandError {
    CommandError::from_message(operation, error)
}

pub(super) fn validate_service_url(base_url: &str) -> Result<Url, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("AI 服务地址不能为空".to_string());
    }
    let url = Url::parse(trimmed).map_err(|_| "AI 服务地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("AI 服务地址仅支持 HTTP 或 HTTPS".to_string());
    }
    let local_http = url.scheme() == "http" && is_local_endpoint(&url);
    if url.scheme() != "https" && !local_http {
        return Err("远程 AI 服务必须使用 HTTPS".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("AI 服务地址不能包含查询参数或片段".to_string());
    }
    Ok(url)
}

pub(super) fn is_local_endpoint(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

pub(super) fn service_endpoint(base_url: &str, resource: &str) -> Result<Url, String> {
    let mut url = validate_service_url(base_url)?;
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/{resource}"));
    Ok(url)
}

pub(super) fn api_key_for_endpoint(endpoint: &Url) -> Result<Option<String>, String> {
    let api_key = match credentials::get_ai_api_key_optional() {
        Ok(value) => value,
        Err(_) if is_local_endpoint(endpoint) => None,
        Err(error) => return Err(error),
    };
    if api_key.is_none() && !is_local_endpoint(endpoint) {
        Err("尚未保存 AI API Key".to_string())
    } else {
        Ok(api_key)
    }
}

pub(super) fn with_api_key(request: RequestBuilder, api_key: Option<&str>) -> RequestBuilder {
    match api_key {
        Some(value) => request.bearer_auth(value),
        None => request,
    }
}

pub(super) fn normalize_models(entries: Vec<AiModelEntry>) -> Vec<AiModelInfo> {
    let mut seen = HashSet::new();
    let mut models = entries
        .into_iter()
        .filter_map(|model| {
            let id = model.id.trim().to_string();
            (!id.is_empty() && id.chars().count() <= 160 && seen.insert(id.clone())).then_some(
                AiModelInfo {
                    id,
                    owned_by: model.owned_by,
                },
            )
        })
        .collect::<Vec<_>>();
    models.sort_by_cached_key(|model| model.id.to_lowercase());
    models.truncate(500);
    models
}

pub(super) fn validate_model(model: &str) -> Result<&str, String> {
    let model = model.trim();
    if model.is_empty() {
        Err("模型名称不能为空".to_string())
    } else if model.chars().count() > 160 {
        Err("模型名称过长".to_string())
    } else {
        Ok(model)
    }
}

pub(super) fn client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent("FineShell AI Assistant")
        .build()
        .map_err(|error| format!("无法初始化 AI 网络客户端：{error}"))
}

pub(super) async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(500).collect());
    if message.trim().is_empty() {
        format!("AI 服务返回 HTTP {status}")
    } else {
        format!("AI 服务返回 HTTP {status}：{message}")
    }
}

pub(super) fn is_tool_unsupported_error(status: u16, error: &str) -> bool {
    if status != 400 {
        return false;
    }
    let normalized = error.to_lowercase();
    [
        "tool",
        "function call",
        "function_call",
        "不支持工具",
        "工具调用",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

pub(super) fn capability_http_failure(
    kind: AiCapabilityKind,
    status: u16,
    error: String,
) -> AiCapability {
    let normalized = error.to_lowercase();
    let unsupported = match kind {
        AiCapabilityKind::Models => matches!(status, 404 | 405 | 501),
        AiCapabilityKind::Streaming => {
            matches!(status, 404 | 405 | 501)
                || (matches!(status, 400 | 422)
                    && (normalized.contains("stream")
                        || normalized.contains("不支持")
                        || normalized.contains("unsupported")))
        }
        AiCapabilityKind::Tools => {
            matches!(status, 404 | 405 | 501) || is_tool_unsupported_error(status, &error)
        }
    };
    if unsupported {
        AiCapability::unsupported(error)
    } else {
        AiCapability::unknown(error)
    }
}

pub(super) fn valid_stream_probe_event(data: &str) -> Result<bool, String> {
    if data == "[DONE]" {
        return Ok(true);
    }
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("流式响应格式无效：{error}"))?;
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("AI 服务返回错误：{message}"));
    }
    Ok(value.pointer("/choices/0/delta").is_some())
}

pub(super) fn tool_probe_supported(value: &Value) -> bool {
    value
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| {
            calls.iter().any(|call| {
                call.pointer("/function/name").and_then(Value::as_str)
                    == Some("fineshell_capability_probe")
            })
        })
        || value
            .pointer("/choices/0/message/function_call/name")
            .and_then(Value::as_str)
            == Some("fineshell_capability_probe")
}

pub(super) async fn test_basic_chat(
    client: &Client,
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
) -> Result<(), String> {
    let response = with_api_key(client.post(endpoint), api_key)
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false
        }))
        .send()
        .await
        .map_err(|error| format!("无法连接 AI 服务：{error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error(response).await)
    }
}

pub(super) async fn probe_models(
    client: &Client,
    endpoint: Url,
    api_key: Option<&str>,
) -> AiCapability {
    let response = match with_api_key(client.get(endpoint), api_key).send().await {
        Ok(response) => response,
        Err(error) => {
            return AiCapability::unknown(format!("模型列表探测失败：{error}"));
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error = response_error(response).await;
        return capability_http_failure(AiCapabilityKind::Models, status, error);
    }
    match response.json::<AiModelsResponse>().await {
        Ok(response) => AiCapability::supported(format!(
            "模型列表接口可用，返回 {} 个模型",
            normalize_models(response.data).len()
        )),
        Err(error) => AiCapability::unknown(format!("模型列表格式不兼容：{error}")),
    }
}

pub(super) async fn probe_streaming(
    client: &Client,
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
) -> AiCapability {
    let response = match with_api_key(client.post(endpoint), api_key)
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": true
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return AiCapability::unknown(format!("流式响应探测失败：{error}")),
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error = response_error(response).await;
        return capability_http_failure(AiCapabilityKind::Streaming, status, error);
    }

    let mut parser = SseParser::default();
    let mut received = 0usize;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return AiCapability::unknown(format!("读取流式响应失败：{error}"));
            }
        };
        received = received.saturating_add(chunk.len());
        if received > 128 * 1024 {
            return AiCapability::unknown("流式探测响应超过 128 KiB 限制");
        }
        for event in parser.push(&chunk) {
            match valid_stream_probe_event(&event) {
                Ok(true) => return AiCapability::supported("返回了标准 SSE 流式响应"),
                Ok(false) => {}
                Err(error) => return AiCapability::unknown(error),
            }
        }
    }
    AiCapability::unknown("服务接受了流式参数，但未返回标准 SSE 事件")
}

pub(super) async fn probe_tools(
    client: &Client,
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
) -> AiCapability {
    let response = match with_api_key(client.post(endpoint), api_key)
        .json(&json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": "Call the provided fineshell_capability_probe function."
            }],
            "stream": false,
            "tools": [{
                "type": "function",
                "function": {
                    "name": "fineshell_capability_probe",
                    "description": "Confirm function calling support without performing any action.",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }
                }
            }],
            "tool_choice": "auto"
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return AiCapability::unknown(format!("工具调用探测失败：{error}")),
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error = response_error(response).await;
        return capability_http_failure(AiCapabilityKind::Tools, status, error);
    }
    match response.json::<Value>().await {
        Ok(value) if tool_probe_supported(&value) => {
            AiCapability::supported("模型返回了标准工具调用")
        }
        Ok(_) => AiCapability::unknown("服务接受了工具参数，但模型未返回工具调用"),
        Err(error) => AiCapability::unknown(format!("工具调用响应格式不兼容：{error}")),
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::{classify_provider_error, ProviderErrorKind};

    #[test]
    fn normalizes_openai_compatible_provider_errors() {
        assert_eq!(
            classify_provider_error(Some(401), "invalid api key"),
            ProviderErrorKind::Authentication
        );
        assert_eq!(
            classify_provider_error(Some(429), "rate limit exceeded"),
            ProviderErrorKind::RateLimited
        );
        assert_eq!(
            classify_provider_error(Some(400), "tool calling is unsupported"),
            ProviderErrorKind::ToolUnsupported
        );
        assert_eq!(
            classify_provider_error(Some(503), "service unavailable"),
            ProviderErrorKind::Service
        );
        assert_eq!(
            classify_provider_error(None, "invalid response payload"),
            ProviderErrorKind::Protocol
        );
    }
}
