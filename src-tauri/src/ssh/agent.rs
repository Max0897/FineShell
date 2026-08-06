use super::*;

pub(super) const AGENT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const AGENT_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(15);
const AGENT_OUTPUT_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_AGENT_COMMAND_STREAM_BYTES: usize = 128 * 1024;
const MAX_AGENT_COMMAND_EVENT_BYTES: usize = 12 * 1024;

#[derive(Clone)]
pub(crate) struct AgentCommandExecutionContext {
    pub(crate) task_id: String,
    pub(crate) action_id: String,
    pub(crate) submission_id: String,
}

pub(crate) struct AgentCommandExecutionResult {
    pub(crate) output: String,
    pub(crate) output_truncated: bool,
    pub(crate) stdout: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr: String,
    pub(crate) stderr_truncated: bool,
    pub(crate) exit_code: u16,
    pub(crate) duration_ms: u64,
}

pub(super) struct AgentCommandRequest {
    pub(super) app: AppHandle,
    pub(super) context: AgentCommandExecutionContext,
    pub(super) command: String,
    pub(super) current_directory: Option<String>,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) response: SyncSender<Result<AgentCommandExecutionResult, String>>,
}

pub(super) enum AgentSessionCommand {
    Execute(Box<AgentCommandRequest>),
    Close,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn validate_current_directory(current_directory: Option<&str>) -> Result<(), String> {
    let Some(current_directory) = current_directory else {
        return Ok(());
    };
    if !current_directory.starts_with('/')
        || current_directory.len() > 4_096
        || current_directory
            .chars()
            .any(|character| character.is_control())
    {
        return Err("AI 命令的远程工作目录无效".to_string());
    }
    Ok(())
}

fn command_script(command: &str, current_directory: Option<&str>) -> Result<String, String> {
    validate_current_directory(current_directory)?;
    let directory = current_directory
        .map(shell_quote)
        .unwrap_or_else(|| "\"$HOME\"".to_string());
    let script = format!("cd -- {directory} && {command}");
    Ok(format!("sh -lc {}", shell_quote(&script)))
}

fn append_bounded_output(output: &mut Vec<u8>, chunk: &[u8], truncated: &mut bool) {
    output.extend_from_slice(chunk);
    if output.len() > MAX_AGENT_COMMAND_STREAM_BYTES {
        let overflow = output.len() - MAX_AGENT_COMMAND_STREAM_BYTES;
        output.drain(..overflow);
        *truncated = true;
    }
}

fn command_interrupted(cancelled: &AtomicBool, started_at: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("AI 后台命令已取消".to_string());
    }
    if started_at.elapsed() >= AGENT_COMMAND_TIMEOUT {
        return Err("AI 后台命令执行超时".to_string());
    }
    Ok(())
}

fn poll_delay(cancelled: &AtomicBool, started_at: Instant) -> Result<(), String> {
    command_interrupted(cancelled, started_at)?;
    thread::sleep(AGENT_COMMAND_POLL_INTERVAL);
    command_interrupted(cancelled, started_at)
}

fn create_channel(
    session: &Session,
    cancelled: &AtomicBool,
    started_at: Instant,
) -> Result<Channel, String> {
    loop {
        command_interrupted(cancelled, started_at)?;
        match session.channel_session() {
            Ok(channel) => return Ok(channel),
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                if io_error.kind() != io::ErrorKind::WouldBlock {
                    return Err(format!("无法创建 AI 后台 SSH 通道：{message}"));
                }
                poll_delay(cancelled, started_at)?;
            }
        }
    }
}

fn start_command(
    channel: &mut Channel,
    script: &str,
    cancelled: &AtomicBool,
    started_at: Instant,
) -> Result<(), String> {
    loop {
        command_interrupted(cancelled, started_at)?;
        match channel.exec(script) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                if io_error.kind() != io::ErrorKind::WouldBlock {
                    return Err(format!("无法提交 AI 后台命令：{message}"));
                }
                poll_delay(cancelled, started_at)?;
            }
        }
    }
}

fn emit_output(
    app: &AppHandle,
    context: &AgentCommandExecutionContext,
    stdout: &[u8],
    stdout_truncated: bool,
    stderr: &[u8],
    stderr_truncated: bool,
) {
    let event_stdout = stdout
        .len()
        .checked_sub(MAX_AGENT_COMMAND_EVENT_BYTES)
        .map_or(stdout, |start| &stdout[start..]);
    let event_stderr = stderr
        .len()
        .checked_sub(MAX_AGENT_COMMAND_EVENT_BYTES)
        .map_or(stderr, |start| &stderr[start..]);
    let stdout_event_truncated = stdout_truncated || event_stdout.len() < stdout.len();
    let stderr_event_truncated = stderr_truncated || event_stderr.len() < stderr.len();
    let stdout = String::from_utf8_lossy(event_stdout).into_owned();
    let stderr = String::from_utf8_lossy(event_stderr).into_owned();
    let output = combined_output(&stdout, &stderr);
    emit_command_progress(
        app,
        context,
        AgentCommandExecutionPhase::Running,
        AgentCommandOutputSnapshot {
            output_excerpt: Some(output),
            output_truncated: stdout_event_truncated || stderr_event_truncated,
            stdout_excerpt: Some(stdout),
            stdout_truncated: stdout_event_truncated,
            stderr_excerpt: Some(stderr),
            stderr_truncated: stderr_event_truncated,
        },
    );
}

fn combined_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
        (true, true) => String::new(),
    }
}

fn emit_command_progress(
    app: &AppHandle,
    context: &AgentCommandExecutionContext,
    phase: AgentCommandExecutionPhase,
    output: AgentCommandOutputSnapshot,
) {
    let Some(manager) = app.try_state::<AgentTaskManager>() else {
        return;
    };
    match manager.observe_command_progress(
        &context.task_id,
        &context.action_id,
        &context.submission_id,
        phase,
        output,
    ) {
        Ok(events) => emit_task_events(app, events),
        Err(error) => {
            log::warn!(target: "fineshell::agent", "记录 AI 后台命令进度失败: {error}");
        }
    }
}

fn wait_for_close(
    channel: &mut Channel,
    cancelled: &AtomicBool,
    started_at: Instant,
) -> Result<(), String> {
    loop {
        command_interrupted(cancelled, started_at)?;
        match channel.wait_close() {
            Ok(()) => return Ok(()),
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                if io_error.kind() != io::ErrorKind::WouldBlock {
                    return Err(format!("等待 AI 后台命令结束失败：{message}"));
                }
                poll_delay(cancelled, started_at)?;
            }
        }
    }
}

fn exit_status(
    channel: &Channel,
    cancelled: &AtomicBool,
    started_at: Instant,
) -> Result<u16, String> {
    loop {
        command_interrupted(cancelled, started_at)?;
        match channel.exit_status() {
            Ok(status) => return Ok(status.clamp(0, 255) as u16),
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                if io_error.kind() != io::ErrorKind::WouldBlock {
                    return Err(format!("读取 AI 后台命令退出码失败：{message}"));
                }
                poll_delay(cancelled, started_at)?;
            }
        }
    }
}

fn execute_command(
    app: &AppHandle,
    context: &AgentCommandExecutionContext,
    session: &Session,
    command: &str,
    current_directory: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<AgentCommandExecutionResult, String> {
    let script = command_script(command, current_directory)?;
    let started_at = Instant::now();
    let mut channel = create_channel(session, cancelled, started_at)?;
    start_command(&mut channel, &script, cancelled, started_at)?;
    emit_command_progress(
        app,
        context,
        AgentCommandExecutionPhase::Running,
        AgentCommandOutputSnapshot::default(),
    );

    let mut stderr_stream = channel.stderr();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut last_emitted_at = Instant::now();
    let mut output_changed = false;
    let mut buffer = [0_u8; 16 * 1024];
    let read_result = (|| {
        loop {
            command_interrupted(cancelled, started_at)?;
            let mut read_any = false;
            match channel.read(&mut buffer) {
                Ok(0) => {}
                Ok(size) => {
                    append_bounded_output(&mut stdout, &buffer[..size], &mut stdout_truncated);
                    read_any = true;
                    output_changed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("读取 AI 后台命令标准输出失败：{error}")),
            }
            match stderr_stream.read(&mut buffer) {
                Ok(0) => {}
                Ok(size) => {
                    append_bounded_output(&mut stderr, &buffer[..size], &mut stderr_truncated);
                    read_any = true;
                    output_changed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("读取 AI 后台命令错误输出失败：{error}")),
            }
            if output_changed && last_emitted_at.elapsed() >= AGENT_OUTPUT_EMIT_INTERVAL {
                emit_output(
                    app,
                    context,
                    &stdout,
                    stdout_truncated,
                    &stderr,
                    stderr_truncated,
                );
                output_changed = false;
                last_emitted_at = Instant::now();
            }
            if channel.eof() && !read_any {
                break;
            }
            if !read_any {
                poll_delay(cancelled, started_at)?;
            }
        }
        Ok(())
    })();
    if output_changed {
        emit_output(
            app,
            context,
            &stdout,
            stdout_truncated,
            &stderr,
            stderr_truncated,
        );
    }
    read_result?;
    wait_for_close(&mut channel, cancelled, started_at)?;
    let exit_code = exit_status(&channel, cancelled, started_at)?;

    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    Ok(AgentCommandExecutionResult {
        output: combined_output(&stdout, &stderr),
        output_truncated: stdout_truncated || stderr_truncated,
        stdout,
        stdout_truncated,
        stderr,
        stderr_truncated,
        exit_code,
        duration_ms: started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    })
}

pub(super) fn run_agent_session(config: SshAuthConfig, receiver: Receiver<AgentSessionCommand>) {
    let mut session: Option<Session> = None;

    for command in receiver {
        match command {
            AgentSessionCommand::Execute(request) => {
                let AgentCommandRequest {
                    app,
                    context,
                    command,
                    current_directory,
                    cancelled,
                    response,
                } = *request;
                let result = (|| {
                    if session.is_none() {
                        let connected = connect_authenticated_session(&config, &cancelled)?.0;
                        connected.set_blocking(false);
                        session = Some(connected);
                    }
                    execute_command(
                        &app,
                        &context,
                        session.as_ref().expect("agent SSH session initialized"),
                        &command,
                        current_directory.as_deref(),
                        &cancelled,
                    )
                })();
                if result.is_err() {
                    if let Some(session) = session.take() {
                        let _ = session.disconnect(None, "AI background session reset", None);
                    }
                }
                let _ = response.send(result);
            }
            AgentSessionCommand::Close => break,
        }
    }

    if let Some(session) = session {
        let _ = session.disconnect(None, "AI background session closed", None);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_bounded_output, command_interrupted, command_script, validate_current_directory,
        MAX_AGENT_COMMAND_STREAM_BYTES,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    #[test]
    fn builds_non_interactive_shell_command_in_selected_directory() {
        assert_eq!(
            command_script("printf '%s' ok", Some("/srv/app's data")).unwrap(),
            r#"sh -lc 'cd -- '\''/srv/app'\''\'\'''\''s data'\'' && printf '\''%s'\'' ok'"#
        );
    }

    #[test]
    fn rejects_relative_or_control_character_directories() {
        assert!(validate_current_directory(Some("tmp")).is_err());
        assert!(validate_current_directory(Some("/tmp\nnext")).is_err());
        assert!(validate_current_directory(None).is_ok());
    }

    #[test]
    fn cancellation_interrupts_a_running_command_poll() {
        let cancelled = AtomicBool::new(false);
        assert!(command_interrupted(&cancelled, Instant::now()).is_ok());
        cancelled.store(true, Ordering::Release);
        assert_eq!(
            command_interrupted(&cancelled, Instant::now()).unwrap_err(),
            "AI 后台命令已取消"
        );
    }

    #[test]
    fn streamed_output_remains_bounded() {
        let mut output = vec![b'a'; MAX_AGENT_COMMAND_STREAM_BYTES];
        let mut truncated = false;
        append_bounded_output(&mut output, b"tail", &mut truncated);
        assert!(truncated);
        assert_eq!(output.len(), MAX_AGENT_COMMAND_STREAM_BYTES);
        assert!(output.ends_with(b"tail"));
    }
}
