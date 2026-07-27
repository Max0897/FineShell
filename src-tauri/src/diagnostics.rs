use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, State};

const DIAGNOSTIC_CAPACITY: usize = 1_000;
const DUPLICATE_WINDOW_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiagnosticLogLevel {
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl DiagnosticLogLevel {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            _ => Err("不支持的诊断日志级别".to_string()),
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Debug => 0,
            Self::Info => 1,
            Self::Warn => 2,
            Self::Error => 3,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticRecordInput {
    level: DiagnosticLogLevel,
    scope: String,
    message: String,
    context: Option<Value>,
}

#[derive(Clone, Debug)]
struct DiagnosticEntry {
    timestamp_ms: u64,
    level: DiagnosticLogLevel,
    scope: String,
    message: String,
    context: Option<Value>,
    repetitions: u32,
}

#[derive(Default)]
struct DiagnosticBuffer {
    entries: VecDeque<DiagnosticEntry>,
    level: DiagnosticLogLevel,
}

#[derive(Default)]
pub(crate) struct DiagnosticLogState {
    buffer: Mutex<DiagnosticBuffer>,
}

#[derive(Default, Serialize)]
struct DiagnosticLogCounts {
    debug: usize,
    info: usize,
    warn: usize,
    error: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticSummary {
    capacity: usize,
    counts: DiagnosticLogCounts,
    latest_at: Option<u64>,
    level: DiagnosticLogLevel,
    total: usize,
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn private_key_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----")
            .expect("private key redaction regex must be valid")
    })
}

fn url_credentials_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/\s@]+@")
            .expect("URL credential redaction regex must be valid")
    })
}

fn user_host_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b[a-z_][\w.-]*@(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])")
            .expect("user and host redaction regex must be valid")
    })
}

fn secret_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)(password|passphrase|token|authorization|secret)\s*[:=]\s*[^\s,;]+")
            .expect("secret redaction regex must be valid")
    })
}

fn ipv4_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").expect("IPv4 redaction regex must be valid")
    })
}

fn hostname_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b")
            .expect("hostname redaction regex must be valid")
    })
}

fn bracketed_ipv6_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\[[0-9a-f:]*:[0-9a-f:]*\]")
            .expect("bracketed IPv6 redaction regex must be valid")
    })
}

fn ipv6_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)(^|[^0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}($|[^0-9a-f:])")
            .expect("IPv6 redaction regex must be valid")
    })
}

fn unix_path_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(^|[\s(])/(?:[^\s):]+/?)+").expect("Unix path redaction regex must be valid")
    })
}

fn windows_path_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b[a-z]:\\[^\s]+").expect("Windows path redaction regex must be valid")
    })
}

fn redact_text(value: &str) -> String {
    let value = private_key_regex().replace_all(value, "[PRIVATE_KEY]");
    let value = url_credentials_regex().replace_all(&value, "${1}[CREDENTIALS]@");
    let value = user_host_regex().replace_all(&value, "[USER]@[HOST]");
    let value = secret_regex().replace_all(&value, "${1}=[REDACTED]");
    let value = ipv4_regex().replace_all(&value, "[HOST]");
    let value = bracketed_ipv6_regex().replace_all(&value, "[HOST]");
    let value = ipv6_regex().replace_all(&value, "${1}[HOST]${2}");
    let value = hostname_regex().replace_all(&value, "[HOST]");
    let value = unix_path_regex().replace_all(&value, "${1}[PATH]");
    windows_path_regex()
        .replace_all(&value, "[PATH]")
        .into_owned()
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "address",
        "arg",
        "command",
        "content",
        "data",
        "host",
        "password",
        "passphrase",
        "path",
        "privatekey",
        "request",
        "secret",
        "target",
        "token",
        "username",
    ]
    .iter()
    .any(|candidate| key.contains(candidate))
}

fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_text(value)),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if sensitive_key(key) {
                            Value::String("[REDACTED]".to_string())
                        } else {
                            sanitize_value(value)
                        },
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

impl DiagnosticLogState {
    fn record(&self, input: DiagnosticRecordInput) -> Result<(), String> {
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|_| "诊断日志缓冲区不可用".to_string())?;
        if input.level.rank() < buffer.level.rank() {
            return Ok(());
        }

        let now = timestamp_ms();
        let scope = redact_text(&input.scope).chars().take(80).collect();
        let message = redact_text(&input.message).chars().take(2_000).collect();
        let context = input.context.as_ref().map(sanitize_value);
        if let Some(previous) = buffer.entries.back_mut() {
            if previous.level == input.level
                && previous.scope == scope
                && previous.message == message
                && previous.context == context
                && now.saturating_sub(previous.timestamp_ms) <= DUPLICATE_WINDOW_MS
            {
                previous.timestamp_ms = now;
                previous.repetitions = previous.repetitions.saturating_add(1);
                return Ok(());
            }
        }

        buffer.entries.push_back(DiagnosticEntry {
            timestamp_ms: now,
            level: input.level,
            scope,
            message,
            context,
            repetitions: 1,
        });
        while buffer.entries.len() > DIAGNOSTIC_CAPACITY {
            buffer.entries.pop_front();
        }
        Ok(())
    }

    fn summary(&self) -> Result<DiagnosticSummary, String> {
        let buffer = self
            .buffer
            .lock()
            .map_err(|_| "诊断日志缓冲区不可用".to_string())?;
        let mut counts = DiagnosticLogCounts::default();
        for entry in &buffer.entries {
            match entry.level {
                DiagnosticLogLevel::Debug => counts.debug += 1,
                DiagnosticLogLevel::Info => counts.info += 1,
                DiagnosticLogLevel::Warn => counts.warn += 1,
                DiagnosticLogLevel::Error => counts.error += 1,
            }
        }
        Ok(DiagnosticSummary {
            capacity: DIAGNOSTIC_CAPACITY,
            counts,
            latest_at: buffer.entries.back().map(|entry| entry.timestamp_ms),
            level: buffer.level,
            total: buffer.entries.len(),
        })
    }
}

#[tauri::command]
pub(crate) fn diagnostic_set_level(
    state: State<'_, DiagnosticLogState>,
    level: String,
) -> Result<(), String> {
    let level = DiagnosticLogLevel::parse(&level)?;
    state
        .buffer
        .lock()
        .map_err(|_| "诊断日志缓冲区不可用".to_string())?
        .level = level;
    Ok(())
}

#[tauri::command]
pub(crate) fn diagnostic_record(
    state: State<'_, DiagnosticLogState>,
    entry: DiagnosticRecordInput,
) -> Result<(), String> {
    state.record(entry)
}

#[tauri::command]
pub(crate) fn diagnostic_summary(
    state: State<'_, DiagnosticLogState>,
) -> Result<DiagnosticSummary, String> {
    state.summary()
}

#[tauri::command]
pub(crate) fn diagnostic_clear(state: State<'_, DiagnosticLogState>) -> Result<(), String> {
    state
        .buffer
        .lock()
        .map_err(|_| "诊断日志缓冲区不可用".to_string())?
        .entries
        .clear();
    Ok(())
}

#[tauri::command]
pub(crate) fn diagnostic_export(
    app: AppHandle,
    state: State<'_, DiagnosticLogState>,
    path: String,
) -> Result<usize, String> {
    let buffer = state
        .buffer
        .lock()
        .map_err(|_| "诊断日志缓冲区不可用".to_string())?;
    let mut report = format!(
        "FineShell diagnostic log\nversion={}\nplatform={}\narch={}\nexported_at_ms={}\nlevel={}\nentries={}\n\n",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        timestamp_ms(),
        buffer.level.as_str(),
        buffer.entries.len(),
    );
    for entry in &buffer.entries {
        let context = entry
            .context
            .as_ref()
            .map_or_else(|| "{}".to_string(), Value::to_string);
        report.push_str(&format!(
            "timestamp_ms={} level={} scope={} repetitions={} message={} context={}\n",
            entry.timestamp_ms,
            entry.level.as_str(),
            entry.scope,
            entry.repetitions,
            entry.message.replace('\n', "\\n"),
            context,
        ));
    }
    let entry_count = buffer.entries.len();
    drop(buffer);

    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建诊断目录: {error}"))?;
        }
    }
    fs::write(path, report).map_err(|error| format!("无法导出诊断日志: {error}"))?;
    Ok(entry_count)
}

pub(crate) fn record_startup(app: &AppHandle) {
    let mut windows = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    windows.sort();
    let _ = app
        .state::<DiagnosticLogState>()
        .record(DiagnosticRecordInput {
            level: DiagnosticLogLevel::Info,
            scope: "application".to_string(),
            message: "Rust 后端已初始化".to_string(),
            context: Some(serde_json::json!({ "windows": windows })),
        });
}

pub(crate) fn record_native_info<R: Runtime>(
    app: &AppHandle<R>,
    scope: &str,
    message: &str,
    context: Option<Value>,
) {
    let _ = app
        .state::<DiagnosticLogState>()
        .record(DiagnosticRecordInput {
            level: DiagnosticLogLevel::Info,
            scope: scope.to_string(),
            message: message.to_string(),
            context,
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_text() {
        let value =
            redact_text("root@server.example.com 192.168.1.10 /Users/demo/.ssh/id password=hello");
        assert!(!value.contains("root"));
        assert!(!value.contains("server.example.com"));
        assert!(!value.contains("192.168.1.10"));
        assert!(!value.contains("/Users/demo"));
        assert!(!value.contains("hello"));
    }

    #[test]
    fn redacts_sensitive_context_fields() {
        let value = sanitize_value(&json!({
            "operation": "ssh_connect",
            "request": { "address": "server.example.com" },
            "nested": { "password": "secret", "status": "failed" }
        }));
        assert_eq!(
            value,
            json!({
                "operation": "ssh_connect",
                "request": "[REDACTED]",
                "nested": { "password": "[REDACTED]", "status": "failed" }
            })
        );
    }

    #[test]
    fn redacts_url_credentials_ipv6_and_private_keys() {
        let value = redact_text(
            "ssh://root:secret@[2001:db8::1]/home/root -----BEGIN OPENSSH PRIVATE KEY-----\nfake-key\n-----END OPENSSH PRIVATE KEY-----",
        );
        assert!(!value.contains("root:secret"));
        assert!(!value.contains("2001:db8::1"));
        assert!(!value.contains("fake-key"));
        assert!(value.contains("[PRIVATE_KEY]"));
    }

    #[test]
    fn merges_repeated_entries_and_respects_level() {
        let state = DiagnosticLogState::default();
        state
            .record(DiagnosticRecordInput {
                level: DiagnosticLogLevel::Debug,
                scope: "test".to_string(),
                message: "ignored".to_string(),
                context: None,
            })
            .unwrap();
        let input = DiagnosticRecordInput {
            level: DiagnosticLogLevel::Error,
            scope: "test".to_string(),
            message: "failed".to_string(),
            context: None,
        };
        state.record(input.clone()).unwrap();
        state.record(input).unwrap();

        let buffer = state.buffer.lock().unwrap();
        assert_eq!(buffer.entries.len(), 1);
        assert_eq!(buffer.entries[0].repetitions, 2);
    }

    #[test]
    fn bounds_the_ring_buffer() {
        let state = DiagnosticLogState::default();
        for index in 0..(DIAGNOSTIC_CAPACITY + 5) {
            state
                .record(DiagnosticRecordInput {
                    level: DiagnosticLogLevel::Info,
                    scope: "test".to_string(),
                    message: format!("entry-{index}"),
                    context: None,
                })
                .unwrap();
        }

        let buffer = state.buffer.lock().unwrap();
        assert_eq!(buffer.entries.len(), DIAGNOSTIC_CAPACITY);
        assert_eq!(buffer.entries.front().unwrap().message, "entry-5");
    }
}
