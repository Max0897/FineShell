use std::{
    collections::{hash_map::DefaultHasher, BTreeSet},
    hash::{Hash, Hasher},
    sync::LazyLock,
};

use futures_util::StreamExt;
use regex::{Captures, Regex};
use rig_core::{
    agent::{AgentRun, AgentRunStep, ModelTurn, ModelTurnOutcome},
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
    ai::{AiChatMessage, AiToolCall, AiToolRound},
    protocol::AI_STREAM_EVENT,
};

const MAX_AGENT_TURNS: usize = 10;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamPayload {
    request_id: String,
    delta: String,
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

fn dsml_call_id(request_id: &str, index: usize) -> String {
    let mut hasher = DefaultHasher::new();
    request_id.hash(&mut hasher);
    format!("dsml-{:016x}-{}", hasher.finish(), index + 1)
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
            id: dsml_call_id(request_id, calls.len()),
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

fn emit_stream_delta(app: &AppHandle, request_id: &str, delta: String) {
    if delta.is_empty() {
        return;
    }
    let _ = app.emit_to(
        "main",
        AI_STREAM_EVENT,
        StreamPayload {
            request_id: request_id.to_string(),
            delta,
        },
    );
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
    pub tool_calls: Vec<AiToolCall>,
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
    let mut run = AgentRun::new(prompt)
        .with_history(messages)
        .max_turns(MAX_AGENT_TURNS.max(rounds.len() + 1));

    for round in rounds {
        match run
            .next_step()
            .map_err(|error| RigTurnError::protocol(error.to_string()))?
        {
            AgentRunStep::CallModel { .. } => {}
            _ => return Err(RigTurnError::protocol("AI 工具回合状态无法恢复")),
        }

        let mut content = Vec::new();
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
    let mut builder = model
        .completion_request(prompt)
        .messages(history)
        .tools(request.tools);
    if !names.is_empty() {
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
    let mut stream_filter = DsmlStreamFilter::default();
    loop {
        let item = tokio::select! {
            changed = request.cancellation.changed() => {
                if changed.is_ok() && *request.cancellation.borrow() {
                    stream.cancel();
                    return Err(RigTurnError::protocol("AI 请求已取消"));
                }
                continue;
            }
            item = stream.next() => item,
        };
        let Some(item) = item else { break };
        if let StreamedAssistantContent::Text(text) = item.map_err(|error| RigTurnError {
            status: error
                .provider_response_status()
                .map(|status| status.as_u16()),
            message: error
                .provider_response_body()
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string()),
        })? {
            content.push_str(&text.text);
            emit_stream_delta(
                request.app,
                request.request_id,
                stream_filter.push(&text.text),
            );
        }
    }
    if *request.cancellation.borrow() {
        return Err(RigTurnError::protocol("AI 请求已取消"));
    }
    let parsed_dsml = parse_dsml_response(&content, request.request_id)?;
    let choice = if let Some(parsed) = parsed_dsml {
        content = parsed.content;
        let mut response = Vec::new();
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
        emit_stream_delta(request.app, request.request_id, stream_filter.finish());
        stream.choice.clone()
    };
    let usage = stream.usage();
    let message_id = stream.message_id.clone();
    match run
        .model_response(ModelTurn::new(
            message_id,
            choice,
            usage,
            names.clone(),
            names,
        ))
        .map_err(|error| RigTurnError::protocol(error.to_string()))?
    {
        ModelTurnOutcome::Continue { .. } => {}
        ModelTurnOutcome::NeedsResolution(_) => {
            return Err(RigTurnError::protocol("AI 返回了未启用的工具调用"));
        }
        ModelTurnOutcome::TurnRetried => {
            return Err(RigTurnError::protocol("AI 返回的工具调用需要重试"));
        }
    }
    let tool_calls = match run
        .next_step()
        .map_err(|error| RigTurnError::protocol(error.to_string()))?
    {
        AgentRunStep::CallTools { calls } => calls
            .into_iter()
            .map(|call| AiToolCall {
                id: call.tool_call.id,
                name: call.tool_call.function.name,
                arguments: call.tool_call.function.arguments.to_string(),
            })
            .collect(),
        AgentRunStep::Done(response) => {
            if content.is_empty() {
                content = response.output;
            }
            Vec::new()
        }
        AgentRunStep::CallModel { .. } => {
            return Err(RigTurnError::protocol("AI Agent 意外请求了额外模型回合"));
        }
    };
    Ok(RigTurnResult {
        content,
        tool_calls,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::{parse_dsml_response, prepare_turn, tool_definitions, DsmlStreamFilter};
    use crate::ai::{AiChatMessage, AiToolCall, AiToolResult, AiToolRound};

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
    }
}
