#[cfg(test)]
use super::*;

#[derive(Default)]
pub(super) struct SseParser {
    buffer: String,
}

impl SseParser {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut events = Vec::new();
        loop {
            let lf = self.buffer.find("\n\n").map(|index| (index, 2));
            let crlf = self.buffer.find("\r\n\r\n").map(|index| (index, 4));
            let Some((index, delimiter_len)) = (match (lf, crlf) {
                (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            }) else {
                break;
            };
            let event = self.buffer[..index].to_string();
            self.buffer.drain(..index + delimiter_len);
            for line in event.lines() {
                if let Some(data) = line.strip_prefix("data:") {
                    events.push(data.trim_start().to_string());
                }
            }
        }
        events
    }
}

#[cfg(test)]
pub(super) fn stream_delta(data: &str) -> Result<Option<String>, String> {
    if data == "[DONE]" {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("AI 流式响应格式无效：{error}"))?;
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("AI 服务返回错误：{message}"));
    }
    Ok(value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .map(str::to_string))
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[cfg(test)]
pub(super) struct ToolCallDelta {
    index: usize,
    id: Option<String>,
    name: Option<String>,
    arguments: Option<String>,
}

#[cfg(test)]
pub(super) fn stream_tool_call_deltas(data: &str) -> Result<Vec<ToolCallDelta>, String> {
    if data == "[DONE]" {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("AI 流式响应格式无效：{error}"))?;
    let Some(tool_calls) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };
    tool_calls
        .iter()
        .map(|tool_call| {
            let index = tool_call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "AI 工具调用索引无效".to_string())?;
            Ok(ToolCallDelta {
                index,
                id: tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                name: tool_call
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                arguments: tool_call
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

#[cfg(test)]
pub(super) fn apply_tool_call_delta(
    calls: &mut Vec<ToolCallAccumulator>,
    delta: ToolCallDelta,
) -> Result<(), String> {
    if delta.index >= MAX_TOOL_CALLS_PER_ROUND {
        return Err("AI 单轮工具调用数量超过限制".to_string());
    }
    while calls.len() <= delta.index {
        calls.push(ToolCallAccumulator::default());
    }
    let call = &mut calls[delta.index];
    if let Some(id) = delta.id {
        call.id = id;
    }
    if let Some(name) = delta.name {
        call.name.push_str(&name);
    }
    if let Some(arguments) = delta.arguments {
        call.arguments.push_str(&arguments);
    }
    if call.id.len() > 160
        || call.name.len() > 160
        || call.arguments.chars().count() > MAX_TOOL_ARGUMENT_CHARS
    {
        return Err("AI 工具调用内容过长".to_string());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn complete_tool_calls(
    calls: Vec<ToolCallAccumulator>,
) -> Result<Vec<AiToolCall>, String> {
    let calls = calls
        .into_iter()
        .map(|call| {
            let tool_call = AiToolCall {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
            };
            if tool_call.id.trim().is_empty()
                || !supported_tool(&tool_call.name)
                || !valid_tool_arguments(&tool_call.name, &tool_call.arguments)
            {
                return Err("AI 返回了无效的工具调用".to_string());
            }
            Ok(tool_call)
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_diagnostic_plan_calls(&calls)?;
    Ok(calls)
}
