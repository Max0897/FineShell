use std::{
    collections::{hash_map::DefaultHasher, BTreeSet},
    hash::{Hash, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock,
    },
};

use futures_util::StreamExt;
use regex::{Captures, Regex};
use rig_core::{
    agent::{
        AgentRun, AgentRunStep, InvalidToolCallContext, InvalidToolCallHookAction, ModelTurn,
        ModelTurnOutcome,
    },
    client::CompletionClient,
    completion::{CompletionModel, Message, ToolDefinition, Usage},
    message::{
        AssistantContent, ToolCall, ToolChoice, ToolFunction, ToolResultContent, UserContent,
    },
    providers::openai,
    streaming::StreamedAssistantContent,
    OneOrMany,
};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::{
    ai::{AiChatMessage, AiToolCall, AiToolResult, AiToolRound},
    protocol::AI_STREAM_EVENT,
};

const MAX_DSML_TOOL_CALLS: usize = 8;
const MAX_DSML_ARGUMENT_CHARS: usize = 400_000;
const DSML_TOOL_CALLS_OPEN: &str = "<|DSML|tool_calls>";
const DSML_TOOL_CALLS_CLOSE: &str = "</|DSML|tool_calls>";
const DSML_INVOKE_CLOSE: &str = "</|DSML|invoke>";
const DSML_PARAMETER_CLOSE: &str = "</|DSML|parameter>";

static DSML_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<\s*(/?)\s*(?:(?:\||｜)\s*)+DSML\s*(?:(?:\||｜)\s*)+([A-Za-z_]+)([^>]*)>"#)
        .expect("valid DSML tag regex")
});
static DSML_TOOL_CALLS_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<\s*(?:(?:\||｜)\s*)+DSML\s*(?:(?:\||｜)\s*)+tool_calls\s*>"#)
        .expect("valid DSML tool call regex")
});
static DSML_INVOKE_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<\|DSML\|invoke\s+name=\"([^\"]+)\"\s*>$"#).expect("valid DSML invoke regex")
});
static DSML_PARAMETER_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<\|DSML\|parameter\s+name=\"([^\"]+)\"\s+string=\"(true|false)\"\s*>$"#)
        .expect("valid DSML parameter regex")
});
// Hidden corrective turns are not mirrored to the UI, so IDs cannot depend on visible rounds.
static AGENT_TOOL_CALL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamPayload {
    request_id: String,
    delta: String,
    kind: StreamKind,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum StreamKind {
    Content,
    Reasoning,
}

struct ParsedDsmlResponse {
    content: String,
    calls: Vec<AiToolCall>,
}

#[derive(Default)]
struct DsmlStreamFilter {
    pending: String,
    suppressing: bool,
}

impl DsmlStreamFilter {
    fn push(&mut self, delta: &str) -> String {
        if self.suppressing {
            return String::new();
        }
        self.pending.push_str(delta);
        if let Some(marker) = DSML_TOOL_CALLS_START.find(&self.pending) {
            let visible = self.pending[..marker.start()].to_string();
            self.pending.clear();
            self.suppressing = true;
            return visible;
        }

        if let Some(start) = self.pending.rfind('<') {
            if could_start_dsml_marker(&self.pending[start..]) {
                return self.pending.drain(..start).collect();
            }
        }
        std::mem::take(&mut self.pending)
    }

    fn finish(&mut self) -> String {
        if self.suppressing {
            self.pending.clear();
            String::new()
        } else {
            std::mem::take(&mut self.pending)
        }
    }
}

fn could_start_dsml_marker(value: &str) -> bool {
    if value.chars().count() > 64 {
        return false;
    }
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .replace('｜', "|");
    ["<|dsml|tool_calls>", "<||dsml||tool_calls>"]
        .iter()
        .any(|marker| marker.starts_with(&compact))
}

fn normalize_dsml_tags(value: &str) -> String {
    DSML_TAG
        .replace_all(value, |captures: &Captures<'_>| {
            format!(
                "<{}|DSML|{}{}>",
                captures.get(1).map_or("", |value| value.as_str()),
                captures
                    .get(2)
                    .map_or_else(String::new, |value| value.as_str().to_ascii_lowercase()),
                captures.get(3).map_or("", |value| value.as_str())
            )
        })
        .into_owned()
}

fn skip_whitespace(value: &str, cursor: usize) -> usize {
    let remaining = &value[cursor..];
    cursor + remaining.len() - remaining.trim_start_matches(char::is_whitespace).len()
}

fn read_dsml_tag(value: &str, cursor: usize) -> Result<(&str, usize), RigTurnError> {
    let remaining = &value[cursor..];
    let end = remaining
        .find('>')
        .ok_or_else(|| RigTurnError::protocol("AI 返回的 DSML 工具调用标签不完整"))?;
    Ok((&remaining[..=end], cursor + end + 1))
}

fn agent_tool_call_id(request_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    request_id.hash(&mut hasher);
    let sequence = AGENT_TOOL_CALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("agent-{:016x}-{sequence:016x}", hasher.finish(),)
}

fn parse_dsml_response(
    value: &str,
    request_id: &str,
) -> Result<Option<ParsedDsmlResponse>, RigTurnError> {
    let normalized = normalize_dsml_tags(value);
    let Some(start) = normalized.find(DSML_TOOL_CALLS_OPEN) else {
        return Ok(None);
    };
    let content = normalized[..start].trim_end().to_string();
    let mut cursor = start + DSML_TOOL_CALLS_OPEN.len();
    let mut calls = Vec::new();

    loop {
        cursor = skip_whitespace(&normalized, cursor);
        let remaining = &normalized[cursor..];
        if remaining.starts_with(DSML_TOOL_CALLS_CLOSE) {
            cursor += DSML_TOOL_CALLS_CLOSE.len();
            break;
        }
        if calls.len() >= MAX_DSML_TOOL_CALLS {
            return Err(RigTurnError::protocol(
                "AI 返回的 DSML 工具调用数量超过限制",
            ));
        }

        let (invoke_tag, next_cursor) = read_dsml_tag(&normalized, cursor)?;
        let invoke = DSML_INVOKE_OPEN
            .captures(invoke_tag)
            .ok_or_else(|| RigTurnError::protocol("AI 返回的 DSML invoke 标签无效"))?;
        let name = invoke[1].to_string();
        cursor = next_cursor;
        let mut arguments = Map::new();

        loop {
            cursor = skip_whitespace(&normalized, cursor);
            let remaining = &normalized[cursor..];
            if remaining.starts_with(DSML_INVOKE_CLOSE) {
                cursor += DSML_INVOKE_CLOSE.len();
                break;
            }

            let (parameter_tag, next_cursor) = read_dsml_tag(&normalized, cursor)?;
            let parameter = DSML_PARAMETER_OPEN
                .captures(parameter_tag)
                .ok_or_else(|| RigTurnError::protocol("AI 返回的 DSML parameter 标签无效"))?;
            let parameter_name = parameter[1].to_string();
            if arguments.contains_key(&parameter_name) {
                return Err(RigTurnError::protocol("AI 返回了重复的 DSML 工具参数"));
            }
            cursor = next_cursor;
            let parameter_end = normalized[cursor..]
                .find(DSML_PARAMETER_CLOSE)
                .ok_or_else(|| RigTurnError::protocol("AI 返回的 DSML parameter 未闭合"))?;
            let parameter_value = &normalized[cursor..cursor + parameter_end];
            cursor += parameter_end + DSML_PARAMETER_CLOSE.len();
            let parameter_value = if &parameter[2] == "true" {
                Value::String(parameter_value.to_string())
            } else {
                serde_json::from_str(parameter_value.trim()).map_err(|_| {
                    RigTurnError::protocol("AI 返回的 DSML 非字符串参数不是有效 JSON")
                })?
            };
            arguments.insert(parameter_name, parameter_value);
        }

        let arguments = Value::Object(arguments).to_string();
        if arguments.chars().count() > MAX_DSML_ARGUMENT_CHARS {
            return Err(RigTurnError::protocol("AI 返回的 DSML 工具参数过长"));
        }
        calls.push(AiToolCall {
            id: agent_tool_call_id(request_id),
            name,
            arguments,
        });
    }

    if calls.is_empty() {
        return Err(RigTurnError::protocol("AI 返回了空的 DSML 工具调用"));
    }
    if !normalized[cursor..].trim().is_empty() {
        return Err(RigTurnError::protocol(
            "AI 在 DSML 工具调用后返回了意外内容",
        ));
    }
    Ok(Some(ParsedDsmlResponse { content, calls }))
}

fn emit_stream_delta(app: &AppHandle, request_id: &str, delta: String, kind: StreamKind) {
    if delta.is_empty() {
        return;
    }
    let _ = app.emit_to(
        "main",
        AI_STREAM_EVENT,
        StreamPayload {
            request_id: request_id.to_string(),
            delta,
            kind,
        },
    );
}

fn reasoning_stream_delta(accumulated: &mut String, complete: &str) -> String {
    if complete == accumulated.as_str() {
        return String::new();
    }
    if let Some(delta) = complete.strip_prefix(accumulated.as_str()) {
        accumulated.push_str(delta);
        return delta.to_string();
    }
    *accumulated = complete.to_string();
    complete.to_string()
}

pub(crate) struct RigTurnRequest<'a> {
    pub app: &'a AppHandle,
    pub request_id: &'a str,
    pub client: &'a reqwest::Client,
    pub base_url: &'a str,
    pub api_key: Option<&'a str>,
    pub model: &'a str,
    pub messages: Vec<AiChatMessage>,
    pub tool_rounds: &'a [AiToolRound],
    pub tools: Vec<ToolDefinition>,
    pub cancellation: &'a mut watch::Receiver<bool>,
}

pub(crate) struct RigTurnResult {
    pub content: String,
    pub reasoning_content: Option<String>,
    pub tool_calls: Vec<AiToolCall>,
    pub pre_resolved_tool_results: Vec<AiToolResult>,
    pub request_count: u32,
    pub usage: Option<RigTokenUsage>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RigTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
}

impl From<Usage> for RigTokenUsage {
    fn from(usage: Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
            cached_input_tokens: usage.cached_input_tokens,
            reasoning_tokens: usage.reasoning_tokens,
        }
    }
}

#[derive(Debug)]
pub(crate) struct RigTurnError {
    pub message: String,
    pub status: Option<u16>,
}

impl RigTurnError {
    fn protocol(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }
}

fn message(value: AiChatMessage) -> Result<Message, RigTurnError> {
    match value.role.as_str() {
        "system" => Ok(Message::system(value.content)),
        "user" => Ok(Message::user(value.content)),
        "assistant" => Ok(Message::assistant(value.content)),
        _ => Err(RigTurnError::protocol("AI 对话包含不支持的消息角色")),
    }
}

fn tool_call(call: &AiToolCall) -> Result<ToolCall, RigTurnError> {
    let arguments = serde_json::from_str(&call.arguments)
        .map_err(|_| RigTurnError::protocol("AI 工具调用参数不是有效 JSON"))?;
    Ok(ToolCall::new(
        call.id.clone(),
        ToolFunction::new(call.name.clone(), arguments),
    ))
}

fn extract_reasoning_content(choice: &OneOrMany<AssistantContent>) -> Option<String> {
    let parts = choice
        .iter()
        .filter_map(|item| match item {
            AssistantContent::Reasoning(reasoning) => {
                let value = reasoning.display_text();
                (!value.is_empty()).then_some(value)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn has_native_tool_calls(choice: &OneOrMany<AssistantContent>) -> bool {
    choice
        .iter()
        .any(|item| matches!(item, AssistantContent::ToolCall(_)))
}

fn resolve_tool_protocol(
    content: &str,
    choice: &OneOrMany<AssistantContent>,
    request_id: &str,
) -> Result<(String, Option<ParsedDsmlResponse>), RigTurnError> {
    if has_native_tool_calls(choice) {
        let visible = DSML_TOOL_CALLS_START
            .find(content)
            .map_or(content, |marker| &content[..marker.start()])
            .trim_end()
            .to_string();
        return Ok((visible, None));
    }

    let parsed = parse_dsml_response(content, request_id)?;
    let visible = parsed
        .as_ref()
        .map_or_else(|| content.to_string(), |parsed| parsed.content.clone());
    Ok((visible, parsed))
}

struct PreparedTurn {
    run: AgentRun,
    prompt: Message,
    history: Vec<Message>,
}

fn prepare_turn(
    messages: Vec<AiChatMessage>,
    rounds: &[AiToolRound],
    current_tool_names: &BTreeSet<String>,
) -> Result<PreparedTurn, RigTurnError> {
    let mut messages = messages
        .into_iter()
        .map(message)
        .collect::<Result<Vec<_>, _>>()?;
    let prompt = messages
        .pop()
        .ok_or_else(|| RigTurnError::protocol("AI 请求缺少用户消息"))?;
    let mut replay_tool_names = current_tool_names.clone();
    replay_tool_names.extend(
        rounds
            .iter()
            .flat_map(|round| round.calls.iter().map(|call| call.name.clone())),
    );
    // This adapter performs one fresh model turn per invocation. Replayed tool
    // rounds restore Rig's state, so the required budget comes from the saved
    // history instead of imposing a global turn limit on the task.
    let mut run = AgentRun::new(prompt)
        .with_history(messages)
        .max_turns(rounds.len().saturating_add(1));

    for round in rounds {
        match run
            .next_step()
            .map_err(|error| RigTurnError::protocol(error.to_string()))?
        {
            AgentRunStep::CallModel { .. } => {}
            _ => return Err(RigTurnError::protocol("AI 工具回合状态无法恢复")),
        }

        let mut content = Vec::new();
        if let Some(reasoning) = round
            .reasoning_content
            .as_deref()
            .filter(|reasoning| !reasoning.is_empty())
        {
            content.push(AssistantContent::reasoning(reasoning));
        }
        if let Some(text) = round.content.as_deref().filter(|text| !text.is_empty()) {
            content.push(AssistantContent::text(text));
        }
        content.extend(
            round
                .calls
                .iter()
                .map(tool_call)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(AssistantContent::ToolCall),
        );
        let choice = OneOrMany::many(content)
            .map_err(|_| RigTurnError::protocol("AI 工具回合缺少响应内容"))?;
        match run
            .model_response(ModelTurn::new(
                None,
                choice,
                Usage::new(),
                replay_tool_names.clone(),
                replay_tool_names.clone(),
            ))
            .map_err(|error| RigTurnError::protocol(error.to_string()))?
        {
            ModelTurnOutcome::Continue { .. } => {}
            ModelTurnOutcome::NeedsResolution(_) => {
                return Err(RigTurnError::protocol("AI 工具回合包含未注册工具"));
            }
            ModelTurnOutcome::TurnRetried => {
                return Err(RigTurnError::protocol("AI 工具回合需要重新请求"));
            }
        }
        match run
            .next_step()
            .map_err(|error| RigTurnError::protocol(error.to_string()))?
        {
            AgentRunStep::CallTools { .. } => {}
            _ => return Err(RigTurnError::protocol("AI 工具回合没有待处理调用")),
        }
        let results = round
            .results
            .iter()
            .map(|result| {
                UserContent::tool_result(
                    result.call_id.clone(),
                    OneOrMany::one(ToolResultContent::text(result.content.clone())),
                )
            })
            .collect();
        run.tool_results(results)
            .map_err(|error| RigTurnError::protocol(error.to_string()))?;
    }

    match run
        .next_step()
        .map_err(|error| RigTurnError::protocol(error.to_string()))?
    {
        AgentRunStep::CallModel {
            prompt, history, ..
        } => Ok(PreparedTurn {
            run,
            prompt,
            history,
        }),
        _ => Err(RigTurnError::protocol("AI Agent 未进入模型请求状态")),
    }
}

fn tool_names(tools: &[ToolDefinition]) -> BTreeSet<String> {
    tools.iter().map(|tool| tool.name.clone()).collect()
}

pub(crate) fn tool_definitions(value: Value) -> Result<Vec<ToolDefinition>, String> {
    value
        .as_array()
        .ok_or_else(|| "AI 工具定义无效".to_string())?
        .iter()
        .map(|item| {
            let function = item
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| "AI 工具定义缺少 function".to_string())?;
            Ok(ToolDefinition {
                name: function
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "AI 工具定义缺少名称".to_string())?
                    .to_string(),
                description: function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                parameters: function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
            })
        })
        .collect()
}

struct StreamedModelTurn {
    choice: OneOrMany<AssistantContent>,
    content: String,
    message_id: Option<String>,
    reasoning_content: Option<String>,
    usage: Usage,
}

struct ModelTurnStreamContext<'a> {
    tools: &'a [ToolDefinition],
    names: &'a BTreeSet<String>,
    app: &'a AppHandle,
    request_id: &'a str,
}

fn invalid_tool_result(context: &InvalidToolCallContext) -> String {
    if context.allowed_tools.is_empty() {
        return serde_json::json!({
            "ok": false,
            "error": "No tools are available for this turn",
            "retryable": true,
            "instruction": "Do not emit function calls or DSML tool markup. Reply with a plain-text final answer using only the evidence already available."
        })
        .to_string();
    }
    serde_json::json!({
        "ok": false,
        "error": format!("Tool `{}` is unavailable for this turn", invalid_tool_display_name(&context.tool_name)),
        "retryable": true,
        "instruction": format!(
            "You may call only these tools: {}. Retry using an allowed tool, or answer without tools. Do not invent or rename tools.",
            context.allowed_tools.join(", ")
        )
    })
    .to_string()
}

fn invalid_tool_display_name(name: &str) -> String {
    let name = name
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>();
    if name.trim().is_empty() {
        "未知工具".to_string()
    } else {
        name
    }
}

fn skip_invalid_tool_call(
    run: &mut AgentRun,
    context: &InvalidToolCallContext,
) -> Result<ModelTurnOutcome, RigTurnError> {
    run.resolve_invalid_tool_call(InvalidToolCallHookAction::skip(invalid_tool_result(
        context,
    )))
    .map_err(|error| RigTurnError::protocol(error.to_string()))
}

async fn stream_model_turn<M: CompletionModel>(
    model: &M,
    prompt: Message,
    history: Vec<Message>,
    context: &ModelTurnStreamContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<StreamedModelTurn, RigTurnError> {
    let mut builder = model
        .completion_request(prompt)
        .messages(history)
        .tools(context.tools.to_vec());
    if !context.names.is_empty() {
        builder = builder.tool_choice(ToolChoice::Auto);
    }
    let mut stream = builder.stream().await.map_err(|error| RigTurnError {
        status: error
            .provider_response_status()
            .map(|status| status.as_u16()),
        message: error
            .provider_response_body()
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string()),
    })?;
    let mut content = String::new();
    let mut streamed_reasoning = String::new();
    let mut stream_filter = DsmlStreamFilter::default();
    loop {
        let item = tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_ok() && *cancellation.borrow() {
                    stream.cancel();
                    return Err(RigTurnError::protocol("AI 请求已取消"));
                }
                continue;
            }
            item = stream.next() => item,
        };
        let Some(item) = item else { break };
        let item = item.map_err(|error| RigTurnError {
            status: error
                .provider_response_status()
                .map(|status| status.as_u16()),
            message: error
                .provider_response_body()
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string()),
        })?;
        match item {
            StreamedAssistantContent::Text(text) => {
                content.push_str(&text.text);
                emit_stream_delta(
                    context.app,
                    context.request_id,
                    stream_filter.push(&text.text),
                    StreamKind::Content,
                );
            }
            StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                streamed_reasoning.push_str(&reasoning);
                emit_stream_delta(
                    context.app,
                    context.request_id,
                    reasoning,
                    StreamKind::Reasoning,
                );
            }
            StreamedAssistantContent::Reasoning(reasoning) => {
                let complete = reasoning.display_text();
                let delta = reasoning_stream_delta(&mut streamed_reasoning, &complete);
                emit_stream_delta(
                    context.app,
                    context.request_id,
                    delta,
                    StreamKind::Reasoning,
                );
            }
            _ => {}
        }
    }
    if *cancellation.borrow() {
        return Err(RigTurnError::protocol("AI 请求已取消"));
    }
    let original_choice = stream.choice.clone();
    let reasoning_content = extract_reasoning_content(&original_choice);
    if let Some(reasoning) = reasoning_content.as_deref() {
        let delta = reasoning_stream_delta(&mut streamed_reasoning, reasoning);
        emit_stream_delta(
            context.app,
            context.request_id,
            delta,
            StreamKind::Reasoning,
        );
    }
    let (resolved_content, parsed_dsml) =
        resolve_tool_protocol(&content, &original_choice, context.request_id)?;
    content = resolved_content;
    let choice = if let Some(parsed) = parsed_dsml {
        let mut response = Vec::new();
        if let Some(reasoning) = reasoning_content.as_deref() {
            response.push(AssistantContent::reasoning(reasoning));
        }
        if !content.is_empty() {
            response.push(AssistantContent::text(content.clone()));
        }
        response.extend(
            parsed
                .calls
                .iter()
                .map(tool_call)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(AssistantContent::ToolCall),
        );
        OneOrMany::many(response)
            .map_err(|_| RigTurnError::protocol("AI 返回的 DSML 工具调用为空"))?
    } else {
        emit_stream_delta(
            context.app,
            context.request_id,
            stream_filter.finish(),
            StreamKind::Content,
        );
        original_choice
    };
    Ok(StreamedModelTurn {
        choice,
        content,
        message_id: stream.message_id.clone(),
        reasoning_content,
        usage: stream.usage(),
    })
}

pub(crate) async fn request_turn(
    request: RigTurnRequest<'_>,
) -> Result<RigTurnResult, RigTurnError> {
    let names = tool_names(&request.tools);
    let PreparedTurn {
        mut run,
        prompt,
        history,
    } = prepare_turn(request.messages, request.tool_rounds, &names)?;
    let rig_client = openai::CompletionsClient::builder()
        .api_key(request.api_key.unwrap_or("fineshell-local"))
        .base_url(request.base_url)
        .http_client(request.client.clone())
        .build()
        .map_err(|error| RigTurnError::protocol(format!("创建 AI 客户端失败：{error}")))?;
    let model = rig_client.completion_model(request.model);
    let stream_context = ModelTurnStreamContext {
        tools: &request.tools,
        names: &names,
        app: request.app,
        request_id: request.request_id,
    };
    let mut aggregate_usage = Usage::new();
    let mut request_count = 0_u32;
    let streamed = stream_model_turn(
        &model,
        prompt,
        history,
        &stream_context,
        request.cancellation,
    )
    .await?;
    let StreamedModelTurn {
        choice,
        mut content,
        message_id,
        reasoning_content,
        usage,
    } = streamed;
    request_count = request_count.saturating_add(1);
    aggregate_usage += usage;
    let mut outcome = run
        .model_response(ModelTurn::new(
            message_id,
            choice,
            usage,
            names.clone(),
            names.clone(),
        ))
        .map_err(|error| RigTurnError::protocol(error.to_string()))?;
    loop {
        match outcome {
            ModelTurnOutcome::Continue { .. } => break,
            ModelTurnOutcome::NeedsResolution(context) => {
                outcome = skip_invalid_tool_call(&mut run, &context)?;
            }
            ModelTurnOutcome::TurnRetried => {
                return Err(RigTurnError::protocol("AI 工具调用状态无效"));
            }
        }
    }
    let (tool_calls, pre_resolved_tool_results) = match run
        .next_step()
        .map_err(|error| RigTurnError::protocol(error.to_string()))?
    {
        AgentRunStep::CallTools { calls } => {
            let mut tool_calls = Vec::with_capacity(calls.len());
            let mut pre_resolved_tool_results = Vec::new();
            for call in calls {
                let id = agent_tool_call_id(request.request_id);
                let name = call.tool_call.function.name;
                if let Some(UserContent::ToolResult(result)) = call.preresolved_result {
                    let content = result
                        .content
                        .into_iter()
                        .filter_map(|content| match content {
                            ToolResultContent::Text(text) => Some(text.text),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    pre_resolved_tool_results.push(AiToolResult {
                        call_id: id.clone(),
                        name: name.clone(),
                        content,
                    });
                }
                tool_calls.push(AiToolCall {
                    id,
                    name,
                    arguments: call.tool_call.function.arguments.to_string(),
                });
            }
            (tool_calls, pre_resolved_tool_results)
        }
        AgentRunStep::Done(response) => {
            if content.is_empty() {
                content = response.output;
            }
            (Vec::new(), Vec::new())
        }
        AgentRunStep::CallModel { .. } => {
            return Err(RigTurnError::protocol("AI Agent 意外请求了额外模型回合"));
        }
    };
    Ok(RigTurnResult {
        content,
        reasoning_content,
        tool_calls,
        pre_resolved_tool_results,
        request_count,
        usage: aggregate_usage
            .has_values()
            .then(|| RigTokenUsage::from(aggregate_usage)),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rig_core::{
        agent::{AgentRun, AgentRunStep, InvalidToolCallContext, ModelTurn, ModelTurnOutcome},
        completion::{Message, Usage},
        message::{AssistantContent, ToolCall, ToolFunction},
        OneOrMany,
    };
    use serde_json::json;

    use super::{
        extract_reasoning_content, invalid_tool_result, parse_dsml_response, prepare_turn,
        reasoning_stream_delta, resolve_tool_protocol, skip_invalid_tool_call, tool_definitions,
        DsmlStreamFilter, StreamKind, StreamPayload,
    };
    use crate::ai::{AiChatMessage, AiToolCall, AiToolResult, AiToolRound};

    fn unknown_tool_context(
        run: &mut AgentRun,
        tool_name: &str,
        allowed_tools: BTreeSet<String>,
    ) -> InvalidToolCallContext {
        let choice = OneOrMany::one(AssistantContent::ToolCall(ToolCall::new(
            "unknown-call".to_string(),
            ToolFunction::new(tool_name.to_string(), json!({})),
        )));
        match run
            .model_response(ModelTurn::new(
                None,
                choice,
                Usage::new(),
                allowed_tools.clone(),
                allowed_tools,
            ))
            .unwrap()
        {
            ModelTurnOutcome::NeedsResolution(context) => context,
            _ => panic!("unknown tool must require resolution"),
        }
    }

    fn expect_model_turn(run: &mut AgentRun) {
        assert!(matches!(
            run.next_step().unwrap(),
            AgentRunStep::CallModel { .. }
        ));
    }

    #[test]
    fn converts_openai_tool_definitions_for_rig() {
        let tools = tool_definitions(json!([{
            "type": "function",
            "function": {
                "name": "read_status",
                "description": "Read status",
                "parameters": { "type": "object" }
            }
        }]))
        .unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read_status");
        assert_eq!(tools[0].parameters["type"], "object");
    }

    #[test]
    fn turns_one_unknown_tool_into_a_pre_resolved_result() {
        let mut run = AgentRun::new("inspect").max_turns(2);
        expect_model_turn(&mut run);
        let context = unknown_tool_context(
            &mut run,
            "invented_tool",
            BTreeSet::from(["get_server_status".to_string()]),
        );

        assert!(invalid_tool_result(&context).contains("get_server_status"));
        assert!(matches!(
            skip_invalid_tool_call(&mut run, &context).unwrap(),
            ModelTurnOutcome::Continue { .. }
        ));
        let AgentRunStep::CallTools { calls } = run.next_step().unwrap() else {
            panic!("skipped tool must produce a tool-result round");
        };
        assert_eq!(calls.len(), 1);
        assert!(calls[0].preresolved_result.is_some());
    }

    #[test]
    fn asks_for_plain_text_through_a_tool_result_when_no_tools_are_available() {
        let mut run = AgentRun::new("summarize").max_turns(2);
        expect_model_turn(&mut run);
        let context = unknown_tool_context(&mut run, "stale_tool", BTreeSet::new());

        let feedback = invalid_tool_result(&context);
        assert!(feedback.contains("No tools are available"));
        assert!(feedback.contains("plain-text final answer"));
        assert!(matches!(
            skip_invalid_tool_call(&mut run, &context).unwrap(),
            ModelTurnOutcome::Continue { .. }
        ));
    }

    #[test]
    fn parses_canonical_dsml_tool_calls() {
        let parsed = parse_dsml_response(
            r#"先检查配置。
<｜DSML｜tool_calls>
<｜DSML｜invoke name="propose_terminal_command">
<｜DSML｜parameter name="command" string="true">find / -name "nginx.conf" -type f 2>/dev/null</｜DSML｜parameter>
<｜DSML｜parameter name="purpose" string="true">搜索 Nginx 配置文件</｜DSML｜parameter>
<｜DSML｜parameter name="metadata" string="false">{"source":"agent"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>"#,
            "request-1",
        )
        .unwrap()
        .unwrap();

        assert_eq!(parsed.content, "先检查配置。");
        assert_eq!(parsed.calls.len(), 1);
        assert_eq!(parsed.calls[0].name, "propose_terminal_command");
        let arguments: serde_json::Value =
            serde_json::from_str(&parsed.calls[0].arguments).unwrap();
        assert_eq!(
            arguments["command"],
            r#"find / -name "nginx.conf" -type f 2>/dev/null"#
        );
        assert_eq!(arguments["purpose"], "搜索 Nginx 配置文件");
        assert_eq!(arguments["metadata"]["source"], "agent");
    }

    #[test]
    fn native_tool_calls_take_precedence_over_dsml_fallback_markup() {
        let choice = OneOrMany::many(vec![
            AssistantContent::text("Use the native call."),
            AssistantContent::ToolCall(ToolCall::new(
                "native-call".to_string(),
                ToolFunction::new("get_server_status".to_string(), json!({})),
            )),
        ])
        .unwrap();
        let content = r#"Use the native call.
<|DSML|tool_calls><|DSML|invoke name="get_server_status"><|DSML|parameter name="reason" string="true">duplicate</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>"#;

        let (visible, fallback) =
            resolve_tool_protocol(content, &choice, "request-native").unwrap();

        assert_eq!(visible, "Use the native call.");
        assert!(fallback.is_none());
        assert!(choice
            .iter()
            .any(|item| matches!(item, AssistantContent::ToolCall(_))));
    }

    #[test]
    fn dsml_is_used_only_when_native_tool_calls_are_absent() {
        let choice = OneOrMany::one(AssistantContent::text("compatibility response"));
        let content = r#"Checking.
<|DSML|tool_calls><|DSML|invoke name="get_server_status"><|DSML|parameter name="reason" string="true">inspect</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>"#;

        let (visible, fallback) =
            resolve_tool_protocol(content, &choice, "request-fallback").unwrap();

        assert_eq!(visible, "Checking.");
        let fallback = fallback.expect("DSML fallback must be parsed without native calls");
        assert_eq!(fallback.calls.len(), 1);
        assert_eq!(fallback.calls[0].name, "get_server_status");
    }

    #[test]
    fn parses_ascii_dsml_variant_without_exposing_protocol_text() {
        let parsed = parse_dsml_response(
            r#"<||DSML||tool_calls><||DSML||invoke name="get_server_status"><||DSML||parameter name="scope" string="true">network</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>"#,
            "request-2",
        )
        .unwrap()
        .unwrap();

        assert!(parsed.content.is_empty());
        assert_eq!(parsed.calls.len(), 1);
        assert_eq!(parsed.calls[0].name, "get_server_status");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&parsed.calls[0].arguments).unwrap()["scope"],
            "network"
        );
    }

    #[test]
    fn parses_dsml_with_whitespace_between_ascii_delimiters() {
        let parsed = parse_dsml_response(
            r#"< | | DSML | | tool_calls>< | | DSML | | invoke name="read_status">< | | DSML | | parameter name="scope" string="true">network</ | | DSML | | parameter></ | | DSML | | invoke></ | | DSML | | tool_calls>"#,
            "request-spaced",
        )
        .unwrap()
        .unwrap();

        assert_eq!(parsed.calls.len(), 1);
        assert_eq!(parsed.calls[0].name, "read_status");
    }

    #[test]
    fn filters_a_dsml_marker_split_across_stream_chunks() {
        let mut filter = DsmlStreamFilter::default();
        let mut visible = filter.push("让我检查。<｜DS");
        visible.push_str(&filter.push("ML｜tool_calls><｜DSML｜invoke"));
        visible.push_str(&filter.push(" name=\"read_status\">"));
        visible.push_str(&filter.finish());

        assert_eq!(visible, "让我检查。");
        assert!(!visible.contains("DSML"));
    }

    #[test]
    fn streams_normal_text_without_waiting_for_a_dsml_sized_buffer() {
        let mut filter = DsmlStreamFilter::default();
        assert_eq!(filter.push("普通流式回复"), "普通流式回复");
        assert_eq!(filter.finish(), "");
    }

    #[test]
    fn emits_only_new_reasoning_when_a_provider_repeats_the_complete_value() {
        let mut accumulated = String::new();

        assert_eq!(
            reasoning_stream_delta(&mut accumulated, "检查配置"),
            "检查配置"
        );
        assert_eq!(
            reasoning_stream_delta(&mut accumulated, "检查配置并读取进程"),
            "并读取进程"
        );
        assert_eq!(
            reasoning_stream_delta(&mut accumulated, "检查配置并读取进程"),
            ""
        );
    }

    #[test]
    fn serializes_reasoning_as_a_distinct_stream_event_kind() {
        let payload = serde_json::to_value(StreamPayload {
            request_id: "request-1".to_string(),
            delta: "检查配置".to_string(),
            kind: StreamKind::Reasoning,
        })
        .unwrap();

        assert_eq!(payload["requestId"], "request-1");
        assert_eq!(payload["kind"], "reasoning");
    }

    #[test]
    fn rejects_duplicate_dsml_parameters() {
        let result = parse_dsml_response(
            r#"<｜DSML｜tool_calls><｜DSML｜invoke name="read_status"><｜DSML｜parameter name="scope" string="true">one</｜DSML｜parameter><｜DSML｜parameter name="scope" string="true">two</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>"#,
            "request-3",
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("duplicate DSML parameters must fail"),
        };

        assert!(error.message.contains("重复"));
    }

    #[test]
    fn allocates_unique_tool_call_ids_when_visible_round_state_repeats() {
        let response = r#"<｜DSML｜tool_calls><｜DSML｜invoke name="get_server_status"><｜DSML｜parameter name="scope" string="true">all</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>"#;
        let first = parse_dsml_response(response, "request-stable")
            .unwrap()
            .unwrap();
        let hidden_retry = parse_dsml_response(response, "request-stable")
            .unwrap()
            .unwrap();
        let next = parse_dsml_response(response, "request-stable")
            .unwrap()
            .unwrap();

        assert_ne!(first.calls[0].id, hidden_retry.calls[0].id);
        assert_ne!(first.calls[0].id, next.calls[0].id);
        assert_ne!(hidden_retry.calls[0].id, next.calls[0].id);
    }

    #[test]
    fn restores_a_paused_tool_round_before_the_next_model_turn() {
        let prepared = prepare_turn(
            vec![
                AiChatMessage {
                    role: "system".to_string(),
                    content: "system".to_string(),
                },
                AiChatMessage {
                    role: "user".to_string(),
                    content: "inspect".to_string(),
                },
            ],
            &[AiToolRound {
                calls: vec![AiToolCall {
                    id: "call-1".to_string(),
                    name: "get_server_status".to_string(),
                    arguments: "{}".to_string(),
                }],
                content: None,
                reasoning_content: Some("hidden provider reasoning".to_string()),
                results: vec![AiToolResult {
                    call_id: "call-1".to_string(),
                    name: "get_server_status".to_string(),
                    content: "{\"ok\":true}".to_string(),
                }],
            }],
            &BTreeSet::from(["get_server_status".to_string()]),
        )
        .unwrap();

        assert_eq!(prepared.history.len(), 3);
        let Some(content) = prepared.history.iter().find_map(|message| match message {
            Message::Assistant { content, .. } => Some(content),
            _ => None,
        }) else {
            panic!("restored tool call must be an assistant message");
        };
        assert!(content.iter().any(|item| matches!(
            item,
            AssistantContent::Reasoning(reasoning)
                if reasoning.display_text() == "hidden provider reasoning"
        )));
    }

    #[test]
    fn extracts_streamed_reasoning_for_a_tool_round() {
        let choice = OneOrMany::many(vec![
            AssistantContent::reasoning("inspect config"),
            AssistantContent::reasoning("then compare processes"),
            AssistantContent::ToolCall(ToolCall::new(
                "call-1".to_string(),
                ToolFunction::new("get_server_status".to_string(), json!({})),
            )),
        ])
        .unwrap();

        assert_eq!(
            extract_reasoning_content(&choice).as_deref(),
            Some("inspect config\nthen compare processes")
        );
    }

    #[test]
    fn derives_the_rig_turn_budget_from_all_restored_rounds() {
        let rounds = (0..12)
            .map(|index| AiToolRound {
                calls: vec![AiToolCall {
                    id: format!("call-{index}"),
                    name: "get_server_status".to_string(),
                    arguments: "{}".to_string(),
                }],
                content: None,
                reasoning_content: None,
                results: vec![AiToolResult {
                    call_id: format!("call-{index}"),
                    name: "get_server_status".to_string(),
                    content: format!(r#"{{"ok":true,"round":{index}}}"#),
                }],
            })
            .collect::<Vec<_>>();
        let prepared = prepare_turn(
            vec![
                AiChatMessage {
                    role: "system".to_string(),
                    content: "system".to_string(),
                },
                AiChatMessage {
                    role: "user".to_string(),
                    content: "inspect".to_string(),
                },
            ],
            &rounds,
            &BTreeSet::from(["get_server_status".to_string()]),
        )
        .unwrap();

        assert_eq!(prepared.history.len(), 25);
    }
}
