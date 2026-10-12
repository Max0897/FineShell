use super::*;

pub(super) const HEALTH_PROBE_INTERVAL: Duration = Duration::from_secs(10);
pub(super) const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq)]
enum SessionHealthState {
    Connected,
    Suspect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum SessionHealthUpdate {
    Connected,
    Suspect,
}

pub(super) struct SessionHealth {
    state: SessionHealthState,
    suspect_since: Option<Instant>,
}

impl SessionHealth {
    pub(super) fn new() -> Self {
        Self {
            state: SessionHealthState::Connected,
            suspect_since: None,
        }
    }

    pub(super) fn confirm(&mut self) -> Option<SessionHealthUpdate> {
        self.suspect_since = None;
        if self.state == SessionHealthState::Suspect {
            self.state = SessionHealthState::Connected;
            Some(SessionHealthUpdate::Connected)
        } else {
            None
        }
    }

    pub(super) fn mark_suspect(&mut self, now: Instant) -> Option<SessionHealthUpdate> {
        if self.state == SessionHealthState::Connected {
            self.state = SessionHealthState::Suspect;
            self.suspect_since = Some(now);
            Some(SessionHealthUpdate::Suspect)
        } else {
            None
        }
    }

    pub(super) fn confirmation_timed_out(&self, now: Instant) -> bool {
        self.suspect_since
            .is_some_and(|since| now.duration_since(since) >= HEALTH_CONFIRMATION_TIMEOUT)
    }
}

pub(super) struct RemoteCommandOutput {
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) exit_status: i32,
}

pub(super) enum RemoteCommandPoll {
    Pending(bool),
    Finished {
        result: Result<RemoteCommandOutput, String>,
    },
}

pub(super) struct PendingRemoteCommand {
    command: String,
    operation: &'static str,
    channel: Option<Channel>,
    exec_started: bool,
    output: Vec<u8>,
    error_output: Vec<u8>,
    started_at: Instant,
    timeout: Duration,
}

impl PendingRemoteCommand {
    pub(super) fn new(
        script: &str,
        operation: &'static str,
        timeout: Duration,
        now: Instant,
    ) -> Self {
        Self {
            command: remote_shell::posix_script(script),
            operation,
            channel: None,
            exec_started: false,
            output: Vec::new(),
            error_output: Vec::new(),
            started_at: now,
            timeout,
        }
    }

    pub(super) fn poll(&mut self, session: &Session, now: Instant) -> RemoteCommandPoll {
        if now.duration_since(self.started_at) >= self.timeout {
            return RemoteCommandPoll::Finished {
                result: Err(format!("{}命令响应超时", self.operation)),
            };
        }

        let mut active = false;
        if self.channel.is_none() {
            match session.channel_session() {
                Ok(channel) => {
                    self.channel = Some(channel);
                    active = true;
                }
                Err(error) => {
                    let message = error.to_string();
                    let io_error: io::Error = error.into();
                    return if io_error.kind() == io::ErrorKind::WouldBlock {
                        RemoteCommandPoll::Pending(active)
                    } else {
                        RemoteCommandPoll::Finished {
                            result: Err(format!("无法创建{}通道：{message}", self.operation)),
                        }
                    };
                }
            }
        }

        let channel = self.channel.as_mut().expect("remote channel is present");
        if !self.exec_started {
            match channel.exec(&self.command) {
                Ok(()) => {
                    self.exec_started = true;
                    active = true;
                }
                Err(error) => {
                    let message = error.to_string();
                    let io_error: io::Error = error.into();
                    return if io_error.kind() == io::ErrorKind::WouldBlock {
                        RemoteCommandPoll::Pending(active)
                    } else {
                        RemoteCommandPoll::Finished {
                            result: Err(format!("无法执行{}命令：{message}", self.operation)),
                        }
                    };
                }
            }
        }

        let mut buffer = [0_u8; 8192];
        loop {
            match channel.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    self.output.extend_from_slice(&buffer[..length]);
                    active = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    return RemoteCommandPoll::Finished {
                        result: Err(format!("无法读取{}数据：{error}", self.operation)),
                    };
                }
            }
        }

        // 必须同时排空标准错误，否则远端进程写满标准错误缓冲区后会阻塞，
        // 进而让本应快速失败的命令表现为整体超时。
        {
            let mut stderr_stream = channel.stderr();
            loop {
                match stderr_stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        self.error_output.extend_from_slice(&buffer[..length]);
                        active = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => {
                        return RemoteCommandPoll::Finished {
                            result: Err(format!("无法读取{}错误输出：{error}", self.operation)),
                        };
                    }
                }
            }
        }

        if !channel.eof() {
            return RemoteCommandPoll::Pending(active);
        }
        match channel.wait_close() {
            Ok(()) => {}
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                return if io_error.kind() == io::ErrorKind::WouldBlock {
                    RemoteCommandPoll::Pending(active)
                } else {
                    RemoteCommandPoll::Finished {
                        result: Err(format!("{}通道关闭失败：{message}", self.operation)),
                    }
                };
            }
        }
        match channel.exit_status() {
            Ok(exit_status) => RemoteCommandPoll::Finished {
                result: Ok(RemoteCommandOutput {
                    stdout: String::from_utf8_lossy(&self.output).into_owned(),
                    stderr: String::from_utf8_lossy(&self.error_output).into_owned(),
                    exit_status,
                }),
            },
            Err(error) => {
                let message = error.to_string();
                let io_error: io::Error = error.into();
                if io_error.kind() == io::ErrorKind::WouldBlock {
                    RemoteCommandPoll::Pending(active)
                } else {
                    RemoteCommandPoll::Finished {
                        result: Err(format!("无法读取{}命令状态：{message}", self.operation)),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_activity_recovers_a_suspect_connection() {
        let started_at = Instant::now();
        let mut health = SessionHealth::new();

        assert_eq!(
            health.mark_suspect(started_at),
            Some(SessionHealthUpdate::Suspect)
        );
        assert_eq!(health.mark_suspect(started_at), None);
        assert_eq!(health.confirm(), Some(SessionHealthUpdate::Connected));
        assert!(!health.confirmation_timed_out(started_at + HEALTH_CONFIRMATION_TIMEOUT));
    }

    #[test]
    fn suspect_connection_times_out_without_confirmation() {
        let started_at = Instant::now();
        let mut health = SessionHealth::new();
        assert_eq!(
            health.mark_suspect(started_at),
            Some(SessionHealthUpdate::Suspect)
        );
        assert!(!health.confirmation_timed_out(
            started_at + HEALTH_CONFIRMATION_TIMEOUT - Duration::from_millis(1)
        ));
        assert!(health.confirmation_timed_out(started_at + HEALTH_CONFIRMATION_TIMEOUT));
    }
}
