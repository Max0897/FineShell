use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
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

    const fn as_log_level(self) -> log::Level {
        match self {
            Self::Debug => log::Level::Debug,
            Self::Info => log::Level::Info,
            Self::Warn => log::Level::Warn,
            Self::Error => log::Level::Error,
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

#[derive(Default)]
pub(crate) struct DiagnosticLogState {
    level: Mutex<DiagnosticLogLevel>,
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
        Regex::new(
            r"(?i)(password|passphrase|api[_-]?key|token|authorization|secret)\s*[:=]\s*[^\s,;]+",
        )
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

fn sanitize_scope(value: &str) -> String {
    let scope = value
        .trim()
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | ':' | '-'))
        .take(80)
        .collect::<String>();
    if scope.is_empty() {
        "application".to_string()
    } else {
        scope
    }
}

fn format_entry(input: &DiagnosticRecordInput) -> String {
    let scope = sanitize_scope(&input.scope);
    let message = redact_text(&input.message)
        .chars()
        .take(2_000)
        .collect::<String>()
        .replace('\r', "")
        .replace('\n', "\\n");
    match input.context.as_ref().map(sanitize_value) {
        Some(context) if !context.is_null() => {
            format!("[{scope}] {message} context={context}")
        }
        _ => format!("[{scope}] {message}"),
    }
}

fn log_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("无法定位本地日志目录: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建本地日志目录: {error}"))?;
    Ok(directory)
}

fn current_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = log_directory(app)?.join("fineshell.log");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("无法创建本地日志文件: {error}"))?;
    Ok(path)
}

impl DiagnosticLogState {
    fn record(&self, input: DiagnosticRecordInput) -> Result<(), String> {
        let configured_level = *self
            .level
            .lock()
            .map_err(|_| "诊断日志级别不可用".to_string())?;
        if input.level.rank() < configured_level.rank() {
            return Ok(());
        }

        let level = input.level.as_log_level();
        let entry = format_entry(&input);
        log::log!(target: "fineshell::diagnostics", level, "{entry}");
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn diagnostic_set_level(
    state: State<'_, DiagnosticLogState>,
    level: String,
) -> Result<(), String> {
    let level = DiagnosticLogLevel::parse(&level)?;
    *state
        .level
        .lock()
        .map_err(|_| "诊断日志级别不可用".to_string())? = level;
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
pub(crate) fn diagnostic_open_log(app: AppHandle) -> Result<(), String> {
    let path = current_log_path(&app)?;
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("无法使用默认程序打开日志: {error}"))
}

#[tauri::command]
pub(crate) fn diagnostic_open_log_directory(app: AppHandle) -> Result<(), String> {
    let path = current_log_path(&app)?;
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|error| format!("无法打开本地日志目录: {error}"))
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
    record_native(app, DiagnosticLogLevel::Info, scope, message, context);
}

pub(crate) fn record_native_error<R: Runtime>(
    app: &AppHandle<R>,
    scope: &str,
    message: &str,
    context: Option<Value>,
) {
    record_native(app, DiagnosticLogLevel::Error, scope, message, context);
}

fn record_native<R: Runtime>(
    app: &AppHandle<R>,
    level: DiagnosticLogLevel,
    scope: &str,
    message: &str,
    context: Option<Value>,
) {
    let _ = app
        .state::<DiagnosticLogState>()
        .record(DiagnosticRecordInput {
            level,
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
        let value = redact_text(
            "root@server.example.com 192.168.1.10 /Users/demo/.ssh/id password=hello api_key=sk-sensitive",
        );
        assert!(!value.contains("root"));
        assert!(!value.contains("server.example.com"));
        assert!(!value.contains("192.168.1.10"));
        assert!(!value.contains("/Users/demo"));
        assert!(!value.contains("hello"));
        assert!(!value.contains("sk-sensitive"));
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
    fn formats_a_single_readable_sanitized_line() {
        let entry = format_entry(&DiagnosticRecordInput {
            level: DiagnosticLogLevel::Error,
            scope: "ssh session".to_string(),
            message: "连接 server.example.com 失败\n正在重试".to_string(),
            context: Some(json!({ "status": "failed", "address": "192.168.1.10" })),
        });

        assert_eq!(
            entry,
            "[sshsession] 连接 [HOST] 失败\\n正在重试 context={\"address\":\"[REDACTED]\",\"status\":\"failed\"}"
        );
    }
}
