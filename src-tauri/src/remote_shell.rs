//! 远端命令的统一 POSIX shell 包装。
//!
//! SSH 会话的远端登录 shell 由服务端 `$SHELL` 决定，可能是 fish、csh 等非
//! POSIX shell。FineShell 的监控、进程、网络、归档、业务校验等采集脚本都依赖
//! POSIX 语法（`NAME=value`、`$(...)`、`[ ... ]`、`&&` / `||` 等），如果直接
//! 交给登录 shell 执行，就会在 fish 等 shell 上解析失败（例如
//! `fish: Unsupported use of '='`，退出码 127）。
//!
//! 这里统一把脚本包装成 `sh -c '<转义后的脚本>'`：登录 shell 只负责启动 `sh`，
//! 脚本本身始终由 POSIX shell 解析。这样既保持了对原有 bash/sh 等登录 shell 的
//! 兼容，也能适配 fish 等其它 shell。

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ssh2::{Channel, Session};

/// 轮询标准输出/标准错误时的等待间隔。远端命令的往返延迟远高于此值，因此
/// 2ms 的等待几乎不影响吞吐，却能避免在两条流都无数据时忙等占用 CPU。
const CHANNEL_POLL_INTERVAL: Duration = Duration::from_millis(2);

/// 把任意字符串转义成可以安全拼接进命令行的单个字面量参数。
///
/// 返回值同时兼容 POSIX shell 与 fish：
/// * 单引号包裹的内容在两者中都是字面量，但 fish 会把单引号内的 `\\` 折叠成
///   `\`，因此反斜杠单独用未加引号的 `\\` 表示（两种 shell 都会得到一个字面
///   反斜杠）；
/// * 单引号字符用未加引号的 `\'` 表示（POSIX shell 与 fish 都会得到一个字面
///   单引号）。
///
/// 因此转义结果形如 `'printf '\''\n'\'''`，既不会让 POSIX shell 产生额外展开，
/// 也不会被 fish 误解。
pub(crate) fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    let mut literal = String::new();
    let flush = |literal: &mut String, quoted: &mut String| {
        if !literal.is_empty() {
            quoted.push('\'');
            quoted.push_str(literal);
            quoted.push('\'');
            literal.clear();
        }
    };
    for character in value.chars() {
        match character {
            '\'' => {
                flush(&mut literal, &mut quoted);
                quoted.push_str("\\'");
            }
            '\\' => {
                flush(&mut literal, &mut quoted);
                quoted.push_str("\\\\");
            }
            _ => literal.push(character),
        }
    }
    flush(&mut literal, &mut quoted);
    if quoted.is_empty() {
        return "''".to_string();
    }
    quoted
}

/// 把一段 POSIX 脚本包装成不依赖登录 shell 的命令字符串。
pub(crate) fn posix_script(script: &str) -> String {
    format!("sh -c {}", shell_quote(script))
}

/// 以登录 POSIX shell 执行脚本，用于需要继承用户登录环境（例如 PATH）的场景。
pub(crate) fn posix_login_script(script: &str) -> String {
    format!("sh -lc {}", shell_quote(script))
}

/// 在远端执行一段 POSIX 脚本，返回（合并后的输出，退出码）。
///
/// 通道创建与命令提交使用阻塞模式（这两步需要与服务器往返协商，非阻塞模式下会
/// 返回 `would block`）；随后切到非阻塞模式**同时**排空标准输出与标准错误：SSH
/// 通道窗口由两条流共享，若只读标准输出，远端进程一旦把标准错误写满就会被阻塞，
/// 标准输出随之停滞，读取将永久等待——即死锁。交替排空后任何一条都不会被饿死。
/// 只有命令异常退出（退出码非 0）时才把标准错误并入输出，避免正常结果里混入
/// 无关的告警信息。
pub(crate) fn run_script_blocking(
    session: &Session,
    script: &str,
    action: &str,
) -> Result<(String, i32), String> {
    run_script(session, script, action, None)
}

/// 与 [`run_script_blocking`] 相同，但用于可能长时间无输出的命令（如大文件
/// 压缩/解压）：空闲等待期间检查取消标记，并按会话的保活配置发送 keepalive，
/// 避免静默期间被 NAT 或中间设备断开。取消时关闭通道并返回错误。
pub(crate) fn run_script_cancellable(
    session: &Session,
    script: &str,
    action: &str,
    cancelled: &AtomicBool,
) -> Result<(String, i32), String> {
    run_script(session, script, action, Some(cancelled))
}

fn run_script(
    session: &Session,
    script: &str,
    action: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<(String, i32), String> {
    let command = posix_script(script);
    // 记录并恢复调用前的阻塞模式。SFTP 浏览会话默认是阻塞模式，而监控、进程
    // 等采集会话默认是非阻塞模式。这里必须还原原状态：此前无条件恢复为非阻塞，
    // 会把 SFTP 会话错误地切成非阻塞，导致后续 realpath / readdir 立即返回
    // LIBSSH2_ERROR_EAGAIN（“would block”），表现为“无法解析/读取远程目录”。
    let was_blocking = session.is_blocking();
    // 通道创建与命令提交先用阻塞模式完成：这两个阶段都要和服务器往返协商，
    // 在非阻塞模式下可能返回 LIBSSH2_ERROR_EAGAIN（would block），需要额外的
    // 重试处理。放在阻塞模式里交给 libssh2 按会话自身的超时等待最稳妥；排空
    // 阶段再切到非阻塞，避免阻塞式读取导致标准错误写满时死锁。
    session.set_blocking(true);
    let result = (|| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建{action}通道：{error}"))?;
        channel
            .exec(&command)
            .map_err(|error| format!("无法执行{action}命令：{error}"))?;

        // 命令已提交，切到非阻塞模式交替排空标准输出与标准错误。
        session.set_blocking(false);
        let mut output = Vec::new();
        let mut error_output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let progressed = drain_channel_streams(
                &mut channel,
                &mut output,
                &mut error_output,
                &mut buffer,
                action,
            )?;
            if channel.eof() {
                // 收到 EOF 之后可能仍有残余数据在途，再排空一次即可安全收尾。
                drain_channel_streams(
                    &mut channel,
                    &mut output,
                    &mut error_output,
                    &mut buffer,
                    action,
                )?;
                break;
            }
            if !progressed {
                if let Some(cancelled) = cancelled {
                    if cancelled.load(Ordering::Acquire) {
                        let _ = channel.close();
                        return Err(format!("{action}已取消"));
                    }
                    // 非阻塞模式下发送失败（含 would block）不影响命令本身，
                    // 真正的连接中断会在后续读取时报错。
                    let _ = session.keepalive_send();
                }
                std::thread::sleep(CHANNEL_POLL_INTERVAL);
            }
        }

        // 排空结束、已收到 EOF，切回阻塞模式让 libssh2 用会话自身的超时完成
        // 关闭握手并取回退出码。
        session.set_blocking(true);
        channel
            .wait_close()
            .map_err(|error| format!("{action}通道关闭失败：{error}"))?;
        let exit_status = channel
            .exit_status()
            .map_err(|error| format!("无法读取{action}命令状态：{error}"))?;

        let mut combined = String::from_utf8_lossy(&output).into_owned();
        if exit_status != 0 && !error_output.is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&String::from_utf8_lossy(&error_output));
        }
        Ok((combined, exit_status))
    })();
    session.set_blocking(was_blocking);
    result
}

/// 在非阻塞模式下把通道的标准输出与标准错误排空到底。
///
/// 返回本轮是否读到过数据；两条流都以 `WouldBlock`（暂时无数据）或 `Ok(0)`
/// （EOF）结束。调用方据此决定是否需要短暂等待，避免忙等。
fn drain_channel_streams(
    channel: &mut Channel,
    output: &mut Vec<u8>,
    error_output: &mut Vec<u8>,
    buffer: &mut [u8],
    action: &str,
) -> Result<bool, String> {
    let mut progressed = false;
    loop {
        match channel.read(buffer) {
            Ok(0) => break,
            Ok(length) => {
                output.extend_from_slice(&buffer[..length]);
                progressed = true;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => return Err(format!("无法读取{action}结果：{error}")),
        }
    }
    {
        let mut stderr = channel.stderr();
        loop {
            match stderr.read(buffer) {
                Ok(0) => break,
                Ok(length) => {
                    error_output.extend_from_slice(&buffer[..length]);
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(format!("无法读取{action}错误输出：{error}")),
            }
        }
    }
    Ok(progressed)
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_plain_values_with_single_quotes() {
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_quote("$HOME`id`"), "'$HOME`id`'");
    }

    #[test]
    fn quotes_single_quotes_with_bare_escape() {
        assert_eq!(shell_quote("report's draft"), "'report'\\''s draft'");
        assert_eq!(shell_quote("'"), "\\'");
    }

    #[test]
    fn quotes_backslashes_with_bare_double_backslash() {
        assert_eq!(shell_quote("a\\b"), r#"'a'\\'b'"#);
        assert_eq!(shell_quote("printf '\\n'"), r#"'printf '\'\\'n'\'"#);
    }

    #[test]
    fn keeps_newlines_inside_single_quotes() {
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
    }
}
