use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufWriter, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use vte::{Params, Parser, Perform};

const MIN_LOG_SIZE_MB: u64 = 10;
const MAX_LOG_SIZE_MB: u64 = 2_048;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
const MAX_PENDING_PLAIN_LINE_BYTES: usize = 256 * 1024;

fn default_log_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("无法定位终端日志目录：{error}"))?
        .join("terminal");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建终端日志目录：{error}"))?;
    Ok(directory)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TerminalLogFormat {
    Plain,
    Raw,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLogStartRequest {
    log_id: String,
    session_id: String,
    directory: String,
    host_name: String,
    address: String,
    username: String,
    started_at: String,
    format: TerminalLogFormat,
    max_file_size_mb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLogStartResult {
    path: String,
}

#[derive(Default)]
pub(crate) struct TerminalLogManager {
    sessions: Mutex<HashMap<String, TerminalLogWriter>>,
}

impl TerminalLogManager {
    fn start(&self, request: TerminalLogStartRequest) -> Result<TerminalLogStartResult, String> {
        validate_session_id(&request.log_id)?;
        validate_session_id(&request.session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端日志状态不可用".to_string())?;
        if let Some(mut previous) = sessions.remove(&request.log_id) {
            previous.finish()?;
        }
        let log_id = request.log_id.clone();
        let writer = TerminalLogWriter::new(request)?;
        let path = writer.first_path.to_string_lossy().into_owned();
        sessions.insert(log_id, writer);
        Ok(TerminalLogStartResult { path })
    }

    fn append(&self, log_id: &str, encoded: &str) -> Result<(), String> {
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| format!("终端日志数据无效：{error}"))?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端日志状态不可用".to_string())?;
        sessions
            .get_mut(log_id)
            .ok_or_else(|| "终端日志会话不存在或已停止".to_string())?
            .append(&bytes)
    }

    fn marker(&self, log_id: &str, timestamp: &str, message: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端日志状态不可用".to_string())?;
        sessions
            .get_mut(log_id)
            .ok_or_else(|| "终端日志会话不存在或已停止".to_string())?
            .marker(timestamp, message)
    }

    fn stop(&self, log_id: &str) -> Result<(), String> {
        let writer = self
            .sessions
            .lock()
            .map_err(|_| "终端日志状态不可用".to_string())?
            .remove(log_id);
        if let Some(mut writer) = writer {
            writer.finish()?;
        }
        Ok(())
    }
}

struct TerminalLogWriter {
    directory: PathBuf,
    base_name: String,
    first_path: PathBuf,
    writer: BufWriter<File>,
    format: TerminalLogFormat,
    max_bytes: u64,
    bytes_written: u64,
    segment: u32,
    parser: Parser,
    plain_text: PlainTextPerformer,
    metadata_header: Vec<u8>,
    last_flush: Instant,
}

impl TerminalLogWriter {
    fn new(request: TerminalLogStartRequest) -> Result<Self, String> {
        let directory = PathBuf::from(request.directory.trim());
        if request.directory.trim().is_empty() {
            return Err("终端日志目录不能为空".to_string());
        }
        let metadata =
            fs::metadata(&directory).map_err(|error| format!("无法访问终端日志目录：{error}"))?;
        if !metadata.is_dir() {
            return Err("终端日志路径不是目录".to_string());
        }

        let max_file_size_mb = request
            .max_file_size_mb
            .clamp(MIN_LOG_SIZE_MB, MAX_LOG_SIZE_MB);
        let base_name = log_base_name(&request);
        let metadata_header = metadata_header(&request);
        let (first_path, writer) = open_initial_file(&directory, &base_name)?;
        let mut value = Self {
            directory,
            base_name: first_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&base_name)
                .to_string(),
            first_path,
            writer,
            format: request.format,
            max_bytes: max_file_size_mb * 1024 * 1024,
            bytes_written: 0,
            segment: 1,
            parser: Parser::new(),
            plain_text: PlainTextPerformer::default(),
            metadata_header,
            last_flush: Instant::now(),
        };
        value.write_current_header(false)?;
        Ok(value)
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self.format {
            TerminalLogFormat::Raw => self.write_rotating(bytes)?,
            TerminalLogFormat::Plain => {
                self.parser.advance(&mut self.plain_text, bytes);
                let output = self.plain_text.take_output();
                self.write_rotating(&output)?;
            }
        }
        self.flush_if_due()
    }

    fn marker(&mut self, timestamp: &str, message: &str) -> Result<(), String> {
        if matches!(self.format, TerminalLogFormat::Plain) {
            let pending = self.plain_text.flush_pending_line();
            self.write_rotating(&pending)?;
        }
        let timestamp = marker_text(timestamp, 48);
        let message = marker_text(message, 240);
        self.write_rotating(format!("\n--- {timestamp} {message} ---\n").as_bytes())?;
        self.writer
            .flush()
            .map_err(|error| format!("无法刷新终端日志：{error}"))?;
        self.last_flush = Instant::now();
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if matches!(self.format, TerminalLogFormat::Plain) {
            let pending = self.plain_text.flush_pending_line();
            self.write_rotating(&pending)?;
        }
        self.writer
            .flush()
            .map_err(|error| format!("无法刷新终端日志：{error}"))
    }

    fn flush_if_due(&mut self) -> Result<(), String> {
        if self.last_flush.elapsed() < FLUSH_INTERVAL {
            return Ok(());
        }
        self.writer
            .flush()
            .map_err(|error| format!("无法刷新终端日志：{error}"))?;
        self.last_flush = Instant::now();
        Ok(())
    }

    fn write_rotating(&mut self, mut bytes: &[u8]) -> Result<(), String> {
        while !bytes.is_empty() {
            if self.bytes_written >= self.max_bytes {
                self.rotate()?;
            }
            let available = (self.max_bytes - self.bytes_written) as usize;
            let size = available.min(bytes.len());
            self.writer
                .write_all(&bytes[..size])
                .map_err(|error| format!("无法写入终端日志：{error}"))?;
            self.bytes_written += size as u64;
            bytes = &bytes[size..];
        }
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        self.writer
            .flush()
            .map_err(|error| format!("无法刷新终端日志：{error}"))?;
        self.segment += 1;
        let path = segment_path(&self.directory, &self.base_name, self.segment);
        self.writer = open_private_file(&path)?;
        self.bytes_written = 0;
        self.write_current_header(true)
    }

    fn write_current_header(&mut self, continued: bool) -> Result<(), String> {
        let mut header = self.metadata_header.clone();
        if continued {
            header.extend_from_slice(format!("分卷: {}\n", self.segment).as_bytes());
        }
        header.extend_from_slice(b"\n");
        self.write_rotating(&header)
    }
}

#[derive(Default)]
struct PlainTextPerformer {
    completed: Vec<u8>,
    line: String,
    pending_carriage_return: bool,
}

impl PlainTextPerformer {
    fn prepare_for_text(&mut self) {
        if self.pending_carriage_return {
            self.line.clear();
            self.pending_carriage_return = false;
        }
    }

    fn complete_line(&mut self) {
        self.completed.extend_from_slice(self.line.as_bytes());
        self.completed.push(b'\n');
        self.line.clear();
        self.pending_carriage_return = false;
    }

    fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.completed)
    }

    fn flush_pending_line(&mut self) -> Vec<u8> {
        if !self.line.is_empty() {
            self.complete_line();
        } else {
            self.pending_carriage_return = false;
        }
        self.take_output()
    }
}

impl Perform for PlainTextPerformer {
    fn print(&mut self, character: char) {
        self.prepare_for_text();
        self.line.push(character);
        if self.line.len() >= MAX_PENDING_PLAIN_LINE_BYTES {
            self.completed.extend_from_slice(self.line.as_bytes());
            self.line.clear();
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' | 0x0b | 0x0c => self.complete_line(),
            b'\r' => self.pending_carriage_return = true,
            b'\t' => {
                self.prepare_for_text();
                self.line.push('\t');
            }
            0x08 => {
                self.prepare_for_text();
                self.line.pop();
            }
            _ => {}
        }
    }

    fn hook(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 160 {
        return Err("终端日志会话标识无效".to_string());
    }
    Ok(())
}

fn safe_component(value: &str, fallback: &str, max_chars: usize) -> String {
    let value = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .take(max_chars)
        .collect::<String>()
        .trim_matches(|character| character == '.' || character == '_')
        .to_string();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn marker_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
}

fn log_base_name(request: &TerminalLogStartRequest) -> String {
    let timestamp = safe_component(&request.started_at, "session", 24);
    let host = safe_component(&request.host_name, "host", 48);
    let username = safe_component(&request.username, "user", 32);
    let address = safe_component(&request.address, "address", 64);
    let session = safe_component(&request.session_id, "session", 12);
    format!("{timestamp}_{host}_{username}_{address}_{session}")
}

fn metadata_header(request: &TerminalLogStartRequest) -> Vec<u8> {
    format!(
        "FineShell 终端日志\n开始时间: {}\n主机: {}\n连接: {}@{}\n会话: {}\n格式: {}\n",
        marker_text(&request.started_at, 64),
        marker_text(&request.host_name, 160),
        marker_text(&request.username, 80),
        marker_text(&request.address, 200),
        marker_text(&request.session_id, 160),
        match request.format {
            TerminalLogFormat::Plain => "纯文本",
            TerminalLogFormat::Raw => "原始 ANSI 输出",
        }
    )
    .into_bytes()
}

fn open_initial_file(
    directory: &Path,
    base_name: &str,
) -> Result<(PathBuf, BufWriter<File>), String> {
    for suffix in 1..=1_000_u16 {
        let candidate = if suffix == 1 {
            directory.join(format!("{base_name}.log"))
        } else {
            directory.join(format!("{base_name}-{suffix}.log"))
        };
        match try_open_private_file(&candidate) {
            Ok(file) => return Ok((candidate, BufWriter::new(file))),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建终端日志：{error}")),
        }
    }
    Err("无法生成唯一的终端日志文件名".to_string())
}

fn segment_path(directory: &Path, base_name: &str, segment: u32) -> PathBuf {
    directory.join(format!("{base_name}.part-{segment}.log"))
}

fn try_open_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn open_private_file(path: &Path) -> Result<BufWriter<File>, String> {
    try_open_private_file(path)
        .map(BufWriter::new)
        .map_err(|error| format!("无法创建终端日志分卷：{error}"))
}

#[tauri::command]
pub(crate) fn terminal_log_start(
    app: AppHandle,
    state: State<'_, TerminalLogManager>,
    mut request: TerminalLogStartRequest,
) -> Result<TerminalLogStartResult, String> {
    if request.directory.trim().is_empty() {
        request.directory = default_log_directory(&app)?.to_string_lossy().into_owned();
    }
    state.start(request)
}

#[tauri::command]
pub(crate) fn terminal_log_default_directory(app: AppHandle) -> Result<String, String> {
    Ok(default_log_directory(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn terminal_log_append(
    state: State<'_, TerminalLogManager>,
    log_id: String,
    data: String,
) -> Result<(), String> {
    state.append(&log_id, &data)
}

#[tauri::command]
pub(crate) fn terminal_log_marker(
    state: State<'_, TerminalLogManager>,
    log_id: String,
    timestamp: String,
    message: String,
) -> Result<(), String> {
    state.marker(&log_id, &timestamp, &message)
}

#[tauri::command]
pub(crate) fn terminal_log_stop(
    state: State<'_, TerminalLogManager>,
    log_id: String,
) -> Result<(), String> {
    state.stop(&log_id)
}

#[tauri::command]
pub(crate) fn terminal_log_open_directory(app: AppHandle, directory: String) -> Result<(), String> {
    let directory = if directory.trim().is_empty() {
        default_log_directory(&app)?
    } else {
        PathBuf::from(directory.trim())
    };
    if !directory.is_dir() {
        return Err("终端日志目录不存在".to_string());
    }
    tauri_plugin_opener::open_path(directory, None::<&str>)
        .map_err(|error| format!("无法打开终端日志目录：{error}"))
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::{
        log_base_name, PlainTextPerformer, TerminalLogFormat, TerminalLogManager,
        TerminalLogStartRequest,
    };
    use vte::Parser;

    fn request() -> TerminalLogStartRequest {
        TerminalLogStartRequest {
            log_id: "terminal-log:1".to_string(),
            session_id: "session:1".to_string(),
            directory: "/tmp".to_string(),
            host_name: "测试 / 主机".to_string(),
            address: "2001:db8::1".to_string(),
            username: "root".to_string(),
            started_at: "2026-08-05T14:32:18.000Z".to_string(),
            format: TerminalLogFormat::Plain,
            max_file_size_mb: 100,
        }
    }

    #[test]
    fn creates_cross_platform_safe_log_names() {
        let name = log_base_name(&request());
        assert!(!name
            .chars()
            .any(|character| matches!(character, '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')));
        assert!(name.contains("root"));
    }

    #[test]
    fn plain_text_parser_handles_split_utf8_and_ansi_sequences() {
        let mut parser = Parser::new();
        let mut output = PlainTextPerformer::default();
        let data = "\u{1b}[32m你好\u{1b}[0m\r\n".as_bytes();
        parser.advance(&mut output, &data[..4]);
        parser.advance(&mut output, &data[4..9]);
        parser.advance(&mut output, &data[9..]);
        assert_eq!(String::from_utf8(output.take_output()).unwrap(), "你好\n");
    }

    #[test]
    fn plain_text_parser_keeps_latest_carriage_return_line() {
        let mut parser = Parser::new();
        let mut output = PlainTextPerformer::default();
        parser.advance(&mut output, b"10%\r50%\r100%\r\n");
        assert_eq!(String::from_utf8(output.take_output()).unwrap(), "100%\n");
    }

    #[test]
    fn manager_writes_plain_session_output_and_status_markers() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "fineshell-terminal-log-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let mut request = request();
        request.directory = directory.to_string_lossy().into_owned();
        let manager = TerminalLogManager::default();

        let result = manager.start(request).unwrap();
        manager
            .append(
                "terminal-log:1",
                &STANDARD.encode(b"\x1b[32mready\x1b[0m\r\n"),
            )
            .unwrap();
        manager
            .marker("terminal-log:1", "2026-08-05T10:00:01Z", "连接成功")
            .unwrap();
        manager.stop("terminal-log:1").unwrap();

        let content = fs::read_to_string(&result.path).unwrap();
        assert!(content.contains("FineShell 终端日志"));
        assert!(content.contains("ready\n"));
        assert!(content.contains("连接成功"));
        assert!(!content.contains('\x1b'));
        fs::remove_dir_all(directory).unwrap();
    }
}
