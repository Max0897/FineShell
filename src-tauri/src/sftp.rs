use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, File as LocalFile, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use ssh2::{FileStat, FileType, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{connect_authenticated_session, JumpHostConfig, SshAuthConfig, SshAuthMethod};
use crate::transport::ProxyConfig;

const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const TRANSFER_CANCELLED_ERROR: &str = "传输已取消";
const REMOTE_TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;
const REMOTE_TEXT_CONFLICT_ERROR: &str = "远程文件已被其他程序修改";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpConnectRequest {
    session_id: String,
    host_id: String,
    address: String,
    port: u16,
    username: String,
    auth_method: SshAuthMethod,
    private_key_path: Option<String>,
    connect_timeout_seconds: u64,
    keep_alive_interval_seconds: u32,
    expected_fingerprint: Option<String>,
    proxy: Option<ProxyConfig>,
    jump_host: Option<JumpHostConfig>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpConnectResult {
    fingerprint: String,
    home_dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpEntry {
    id: String,
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    modified_at: Option<u64>,
    permissions: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpListResult {
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpTextFile {
    path: String,
    content: String,
    size: u64,
    modified_at: Option<u64>,
    permissions: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalUploadFile {
    path: String,
    name: String,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferPayload {
    session_id: String,
    transfer_id: String,
    direction: &'static str,
    file_name: String,
    transferred_bytes: u64,
    total_bytes: u64,
    status: &'static str,
    error: Option<String>,
}

enum SftpCommand {
    List {
        path: String,
        reply: Sender<Result<SftpListResult, String>>,
    },
    CreateDirectory {
        path: String,
        reply: Sender<Result<(), String>>,
    },
    CreateFile {
        path: String,
        reply: Sender<Result<(), String>>,
    },
    Rename {
        source_path: String,
        target_path: String,
        overwrite: bool,
        reply: Sender<Result<(), String>>,
    },
    Delete {
        path: String,
        reply: Sender<Result<(), String>>,
    },
    FastDelete {
        paths: Vec<String>,
        reply: Sender<Result<(), String>>,
    },
    SetPermissions {
        path: String,
        permissions: u32,
        reply: Sender<Result<(), String>>,
    },
    ReadTextFile {
        path: String,
        reply: Sender<Result<SftpTextFile, String>>,
    },
    WriteTextFile {
        path: String,
        content: String,
        original_content: String,
        overwrite: bool,
        reply: Sender<Result<SftpTextFile, String>>,
    },
    Close,
}

#[derive(Clone)]
enum SftpHandle {
    Connecting(Arc<AtomicBool>),
    Connected {
        sender: Sender<SftpCommand>,
        auth: Box<SshAuthConfig>,
    },
}

#[derive(Default)]
struct TransferControl {
    cancelled: AtomicBool,
    paused: Mutex<bool>,
    wake: Condvar,
}

impl TransferControl {
    fn pause(&self) -> Result<(), String> {
        let mut paused = self
            .paused
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        *paused = true;
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        let mut paused = self
            .paused
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        *paused = false;
        self.wake.notify_all();
        Ok(())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut paused) = self.paused.lock() {
            *paused = false;
        }
        self.wake.notify_all();
    }
}

#[derive(Clone, Default)]
pub(crate) struct SftpSessionManager {
    sessions: Arc<Mutex<HashMap<String, SftpHandle>>>,
    transfers: Arc<Mutex<TransferRegistry>>,
}

type TransferKey = (String, String);
type TransferRegistry = HashMap<TransferKey, Arc<TransferControl>>;

impl SftpSessionManager {
    fn begin_connect(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        if sessions.contains_key(session_id) {
            return Err("该 SFTP 会话已存在".to_string());
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        sessions.insert(
            session_id.to_string(),
            SftpHandle::Connecting(cancelled.clone()),
        );
        Ok(cancelled)
    }

    fn activate(
        &self,
        session_id: &str,
        sender: Sender<SftpCommand>,
        auth: SshAuthConfig,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        match sessions.get(session_id) {
            Some(SftpHandle::Connecting(cancelled)) if !cancelled.load(Ordering::Acquire) => {
                sessions.insert(
                    session_id.to_string(),
                    SftpHandle::Connected {
                        sender,
                        auth: Box::new(auth),
                    },
                );
                Ok(())
            }
            _ => Err("SFTP 连接已取消".to_string()),
        }
    }

    fn send(&self, session_id: &str, command: SftpCommand) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SFTP 会话不存在或已关闭".to_string())?;
        match handle {
            SftpHandle::Connected { sender, .. } => sender
                .send(command)
                .map_err(|_| "SFTP 会话已停止".to_string()),
            SftpHandle::Connecting(_) => Err("SFTP 会话仍在连接".to_string()),
        }
    }

    fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let handle = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?
            .remove(session_id)
            .ok_or_else(|| "SFTP 会话不存在或已关闭".to_string())?;
        self.cancel_session_transfers(session_id);
        match handle {
            SftpHandle::Connecting(cancelled) => {
                cancelled.store(true, Ordering::Release);
                Ok(())
            }
            SftpHandle::Connected { sender, .. } => sender
                .send(SftpCommand::Close)
                .map_err(|_| "SFTP 会话已停止".to_string()),
        }
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        self.cancel_session_transfers(session_id);
    }

    fn begin_transfer(
        &self,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<(SshAuthConfig, Arc<TransferControl>), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        let auth = match sessions.get(session_id) {
            Some(SftpHandle::Connected { auth, .. }) => auth.as_ref().clone(),
            Some(SftpHandle::Connecting(_)) => return Err("SFTP 会话仍在连接".to_string()),
            None => return Err("SFTP 会话不存在或已关闭".to_string()),
        };
        let key = (session_id.to_string(), transfer_id.to_string());
        let mut transfers = self
            .transfers
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        if transfers.contains_key(&key) {
            return Err("传输任务已存在".to_string());
        }
        let control = Arc::new(TransferControl::default());
        transfers.insert(key, control.clone());
        Ok((auth, control))
    }

    fn transfer_control(
        &self,
        session_id: &str,
        transfer_id: &str,
    ) -> Result<Arc<TransferControl>, String> {
        self.transfers
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?
            .get(&(session_id.to_string(), transfer_id.to_string()))
            .cloned()
            .ok_or_else(|| "传输任务不存在或已结束".to_string())
    }

    fn finish_transfer(&self, session_id: &str, transfer_id: &str) {
        if let Ok(mut transfers) = self.transfers.lock() {
            transfers.remove(&(session_id.to_string(), transfer_id.to_string()));
        }
    }

    fn cancel_session_transfers(&self, session_id: &str) {
        if let Ok(transfers) = self.transfers.lock() {
            for ((task_session_id, _), control) in transfers.iter() {
                if task_session_id == session_id {
                    control.cancel();
                }
            }
        }
    }
}

fn remote_path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn entry_kind(stat: &FileStat) -> &'static str {
    match stat.file_type() {
        FileType::Directory => "directory",
        FileType::RegularFile => "file",
        FileType::Symlink => "symlink",
        _ => "other",
    }
}

fn list_directory(sftp: &Sftp, path: &str) -> Result<SftpListResult, String> {
    let canonical_path = sftp
        .realpath(Path::new(path))
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    let mut entries = sftp
        .readdir(&canonical_path)
        .map_err(|error| format!("无法读取远程目录：{error}"))?
        .into_iter()
        .map(|(entry_path, stat)| {
            let path_text = remote_path_text(&entry_path);
            SftpEntry {
                id: path_text.clone(),
                name: entry_path
                    .file_name()
                    .unwrap_or(entry_path.as_os_str())
                    .to_string_lossy()
                    .into_owned(),
                path: path_text,
                kind: entry_kind(&stat),
                size: stat.size.unwrap_or(0),
                modified_at: stat.mtime,
                permissions: stat.perm.map(|value| value & 0o7777),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_directory = left.kind == "directory";
        let right_directory = right.kind == "directory";
        right_directory
            .cmp(&left_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(SftpListResult {
        path: remote_path_text(&canonical_path),
        entries,
    })
}

fn remote_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn inspect_upload_paths(paths: Vec<String>) -> Result<Vec<LocalUploadFile>, String> {
    if paths.is_empty() {
        return Err("没有选择需要上传的文件".to_string());
    }
    Ok(paths
        .into_iter()
        .filter_map(|path| {
            let local_path = Path::new(&path);
            let metadata = local_path.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(LocalUploadFile {
                name: local_path.file_name()?.to_string_lossy().into_owned(),
                path,
                size: metadata.len(),
            })
        })
        .collect())
}

fn create_empty_file(sftp: &Sftp, path: &str) -> Result<(), String> {
    sftp.open_mode(
        Path::new(path),
        OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
        0o644,
        OpenType::File,
    )
    .map(|_| ())
    .map_err(|error| format!("新建远程文件失败：{error}"))
}

fn set_permissions(sftp: &Sftp, path: &str, permissions: u32) -> Result<(), String> {
    if permissions > 0o7777 {
        return Err("文件权限必须是 000 到 7777 的八进制值".to_string());
    }

    let current = sftp
        .lstat(Path::new(path))
        .map_err(|error| format!("无法读取远程项目信息：{error}"))?;
    let file_type = current.perm.unwrap_or(0) & !0o7777;
    sftp.setstat(
        Path::new(path),
        FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(file_type | permissions),
            atime: None,
            mtime: None,
        },
    )
    .map_err(|error| format!("修改远程项目权限失败：{error}"))
}

fn decode_remote_text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > REMOTE_TEXT_MAX_BYTES {
        return Err("远程文本文件超过 2 MiB，无法直接编辑".to_string());
    }
    if bytes.contains(&0) {
        return Err("该文件包含二进制内容，无法作为文本编辑".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "该文件不是有效的 UTF-8 文本".to_string())
}

fn read_remote_text_file(sftp: &Sftp, path: &str) -> Result<SftpTextFile, String> {
    let remote_path = Path::new(path);
    let before = match sftp.lstat(remote_path) {
        Ok(stat) => stat,
        Err(read_error) => {
            let backup_path = remote_text_backup_path(remote_path)?;
            if !remote_exists(sftp, &backup_path) {
                return Err(format!("无法读取远程文件信息：{read_error}"));
            }
            sftp.rename(&backup_path, remote_path, Some(RenameFlags::empty()))
                .map_err(|restore_error| {
                    format!(
                        "远程编辑可能曾异常中断，无法从 {} 恢复原文件：{restore_error}",
                        backup_path.display()
                    )
                })?;
            sftp.lstat(remote_path)
                .map_err(|error| format!("无法读取恢复后的远程文件信息：{error}"))?
        }
    };
    if !before.is_file() {
        return Err("仅支持打开普通文本文件".to_string());
    }
    if before.size.unwrap_or(0) > REMOTE_TEXT_MAX_BYTES as u64 {
        return Err("远程文本文件超过 2 MiB，无法直接编辑".to_string());
    }

    let remote = sftp
        .open(remote_path)
        .map_err(|error| format!("无法打开远程文本文件：{error}"))?;
    let mut bytes =
        Vec::with_capacity(before.size.unwrap_or(0).min(REMOTE_TEXT_MAX_BYTES as u64) as usize);
    remote
        .take((REMOTE_TEXT_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取远程文本文件：{error}"))?;
    let after = sftp
        .lstat(remote_path)
        .map_err(|error| format!("无法确认远程文件状态：{error}"))?;
    if before.size != after.size || before.mtime != after.mtime {
        return Err("远程文件在读取期间发生变化，请重新打开".to_string());
    }

    Ok(SftpTextFile {
        path: path.to_string(),
        size: bytes.len() as u64,
        content: decode_remote_text(bytes)?,
        modified_at: after.mtime,
        permissions: after.perm.map(|value| value & 0o7777),
    })
}

fn remote_text_temporary_path(remote_path: &Path) -> Result<PathBuf, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成远程临时文件名：{error}"))?
        .as_nanos();
    remote_upload_temporary_path(
        remote_path,
        &format!("edit-{}-{suffix}", std::process::id()),
    )
}

fn remote_text_backup_path(remote_path: &Path) -> Result<PathBuf, String> {
    remote_upload_temporary_path(remote_path, "fineshell-edit-backup")
}

fn replace_remote_text_file(
    sftp: &Sftp,
    temporary_path: &Path,
    remote_path: &Path,
) -> Result<PathBuf, String> {
    let backup_path = remote_text_backup_path(remote_path)?;
    if remote_exists(sftp, &backup_path) {
        sftp.unlink(&backup_path)
            .map_err(|error| format!("无法清理上次远程编辑备份：{error}"))?;
    }
    sftp.rename(remote_path, &backup_path, Some(RenameFlags::empty()))
        .map_err(|error| format!("无法备份原远程文本文件：{error}"))?;

    if let Err(save_error) = sftp.rename(temporary_path, remote_path, Some(RenameFlags::empty())) {
        return match sftp.rename(
            &backup_path,
            remote_path,
            Some(RenameFlags::empty()),
        ) {
            Ok(()) => Err(format!("无法替换远程文本文件：{save_error}")),
            Err(restore_error) => Err(format!(
                "无法替换远程文本文件：{save_error}；原文件保留在 {}，自动恢复失败：{restore_error}",
                backup_path.display()
            )),
        };
    }
    Ok(backup_path)
}

fn write_remote_text_file(
    sftp: &Sftp,
    path: &str,
    content: String,
    original_content: &str,
    overwrite: bool,
) -> Result<SftpTextFile, String> {
    if content.len() > REMOTE_TEXT_MAX_BYTES {
        return Err("编辑后的文本超过 2 MiB，无法保存".to_string());
    }
    if content.as_bytes().contains(&0) {
        return Err("编辑后的文本包含空字符，无法保存".to_string());
    }
    if original_content.len() > REMOTE_TEXT_MAX_BYTES {
        return Err("原始文本内容无效，请重新打开文件".to_string());
    }

    let current = read_remote_text_file(sftp, path)?;
    if current.content != original_content && !overwrite {
        return Err(REMOTE_TEXT_CONFLICT_ERROR.to_string());
    }

    let remote_path = Path::new(path);
    let temporary_path = remote_text_temporary_path(remote_path)?;
    let permissions = current.permissions.unwrap_or(0o644);
    let result = (|| -> Result<SftpTextFile, String> {
        let mut temporary = sftp
            .open_mode(
                &temporary_path,
                OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
                permissions as i32,
                OpenType::File,
            )
            .map_err(|error| format!("无法创建远程编辑临时文件：{error}"))?;
        temporary
            .write_all(content.as_bytes())
            .map_err(|error| format!("无法写入远程编辑临时文件：{error}"))?;
        temporary
            .flush()
            .map_err(|error| format!("无法刷新远程编辑临时文件：{error}"))?;
        drop(temporary);

        sftp.setstat(
            &temporary_path,
            FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(permissions),
                atime: None,
                mtime: None,
            },
        )
        .map_err(|error| format!("无法保留远程文件权限：{error}"))?;
        let backup_path = replace_remote_text_file(sftp, &temporary_path, remote_path)?;

        let verification = read_remote_text_file(sftp, path).and_then(|updated| {
            if updated.content == content {
                Ok(updated)
            } else {
                Err("远程文本文件保存后的内容校验失败".to_string())
            }
        });
        match verification {
            Ok(updated) => {
                let _ = sftp.unlink(&backup_path);
                Ok(updated)
            }
            Err(error) => {
                if remote_exists(sftp, remote_path) {
                    sftp.unlink(remote_path).map_err(|remove_error| {
                        format!(
                            "{error}；原文件保留在 {}，无法移除无效的新文件：{remove_error}",
                            backup_path.display()
                        )
                    })?;
                }
                sftp.rename(&backup_path, remote_path, Some(RenameFlags::empty()))
                    .map_err(|restore_error| {
                        format!(
                            "{error}；原文件保留在 {}，自动恢复失败：{restore_error}",
                            backup_path.display()
                        )
                    })?;
                Err(error)
            }
        }
    })();

    if result.is_err() {
        let _ = sftp.unlink(&temporary_path);
    }
    result
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn fast_delete_command(paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("没有选择需要快速删除的项目".to_string());
    }

    let mut quoted_paths = Vec::with_capacity(paths.len());
    for path in paths {
        if path.contains('\0') || !path.starts_with('/') {
            return Err("快速删除只允许使用有效的绝对路径".to_string());
        }

        let mut has_name = false;
        for component in path.split('/') {
            match component {
                "" | "." => {}
                ".." => return Err("快速删除路径不能包含上级目录".to_string()),
                _ => has_name = true,
            }
        }
        if !has_name {
            return Err("快速删除禁止操作远程根目录".to_string());
        }
        quoted_paths.push(shell_quote(path));
    }

    Ok(format!("rm -rf -- {} 2>&1", quoted_paths.join(" ")))
}

fn fast_delete(session: &Session, paths: &[String]) -> Result<(), String> {
    let command = fast_delete_command(paths)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建快速删除通道：{error}"))?;
    channel
        .exec(&command)
        .map_err(|error| format!("无法执行快速删除命令：{error}"))?;
    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| format!("无法读取快速删除结果：{error}"))?;
    channel
        .wait_close()
        .map_err(|error| format!("快速删除通道关闭失败：{error}"))?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| format!("无法读取快速删除命令状态：{error}"))?;
    if exit_status == 0 {
        Ok(())
    } else {
        let detail = output.trim();
        Err(if detail.is_empty() {
            format!("快速删除命令异常退出：{exit_status}")
        } else {
            format!("快速删除失败：{detail}")
        })
    }
}

fn emit_transfer(app: &AppHandle, payload: SftpTransferPayload) {
    let _ = app.emit_to("main", SFTP_TRANSFER_EVENT, payload);
}

struct TransferReporter<'a> {
    app: &'a AppHandle,
    session_id: &'a str,
    transfer_id: &'a str,
    direction: &'static str,
    file_name: String,
    total_bytes: u64,
}

impl<'a> TransferReporter<'a> {
    fn new(
        app: &'a AppHandle,
        session_id: &'a str,
        transfer_id: &'a str,
        direction: &'static str,
        path: &Path,
        total_bytes: u64,
    ) -> Self {
        Self {
            app,
            session_id,
            transfer_id,
            direction,
            file_name: path
                .file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into_owned(),
            total_bytes,
        }
    }

    fn emit(&self, transferred_bytes: u64, status: &'static str, error: Option<String>) {
        emit_transfer(
            self.app,
            SftpTransferPayload {
                session_id: self.session_id.to_string(),
                transfer_id: self.transfer_id.to_string(),
                direction: self.direction,
                file_name: self.file_name.clone(),
                transferred_bytes,
                total_bytes: self.total_bytes,
                status,
                error,
            },
        );
    }

    fn running(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "running", None);
    }

    fn completed(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "completed", None);
    }

    fn paused(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "paused", None);
    }

    fn cancelled(&self) {
        self.emit(0, "cancelled", None);
    }

    fn failed(&self, error: &str) {
        self.emit(0, "failed", Some(error.to_string()));
    }
}

fn wait_for_transfer(
    control: &TransferControl,
    reporter: &TransferReporter<'_>,
    transferred_bytes: u64,
) -> Result<(), String> {
    if control.cancelled.load(Ordering::Acquire) {
        return Err(TRANSFER_CANCELLED_ERROR.to_string());
    }
    let mut paused = control
        .paused
        .lock()
        .map_err(|_| "传输任务状态不可用".to_string())?;
    if !*paused {
        return Ok(());
    }

    reporter.paused(transferred_bytes);
    while *paused && !control.cancelled.load(Ordering::Acquire) {
        paused = control
            .wake
            .wait(paused)
            .map_err(|_| "传输任务状态不可用".to_string())?;
    }
    if control.cancelled.load(Ordering::Acquire) {
        return Err(TRANSFER_CANCELLED_ERROR.to_string());
    }
    reporter.running(transferred_bytes);
    Ok(())
}

struct TransferTaskContext<'a> {
    app: &'a AppHandle,
    session_id: &'a str,
    control: &'a TransferControl,
    transfer_id: &'a str,
    local_path: &'a str,
    remote_path: &'a str,
    overwrite: bool,
}

fn upload_file(sftp: &Sftp, task: &TransferTaskContext<'_>) -> Result<(), String> {
    let local_path = Path::new(task.local_path);
    let remote_path = Path::new(task.remote_path);
    let metadata = local_path
        .metadata()
        .map_err(|error| format!("无法读取本地文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("当前仅支持上传文件".to_string());
    }
    let total = metadata.len();
    if remote_exists(sftp, remote_path) && !task.overwrite {
        return Err("远程目标已存在，需要确认覆盖".to_string());
    }
    let temporary_path = remote_upload_temporary_path(remote_path, task.transfer_id)?;
    if remote_exists(sftp, &temporary_path) {
        sftp.unlink(&temporary_path)
            .map_err(|error| format!("无法清理上次未完成的上传文件：{error}"))?;
    }

    let reporter = TransferReporter::new(
        task.app,
        task.session_id,
        task.transfer_id,
        "upload",
        local_path,
        total,
    );
    reporter.running(0);
    let mut transferred = 0_u64;
    let result = (|| -> Result<(), String> {
        let mut source =
            LocalFile::open(local_path).map_err(|error| format!("无法打开本地文件：{error}"))?;
        let mut target = sftp
            .create(&temporary_path)
            .map_err(|error| format!("无法创建远程临时文件：{error}"))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
        loop {
            wait_for_transfer(task.control, &reporter, transferred)?;
            let size = source
                .read(&mut buffer)
                .map_err(|error| format!("读取本地文件失败：{error}"))?;
            if size == 0 {
                break;
            }
            target
                .write_all(&buffer[..size])
                .map_err(|error| format!("写入远程文件失败：{error}"))?;
            transferred += size as u64;
            reporter.running(transferred);
        }
        wait_for_transfer(task.control, &reporter, transferred)?;
        target
            .flush()
            .map_err(|error| format!("刷新远程文件失败：{error}"))?;
        drop(target);
        let flags = if task.overwrite {
            RenameFlags::OVERWRITE
        } else {
            RenameFlags::empty()
        };
        sftp.rename(&temporary_path, remote_path, Some(flags))
            .map_err(|error| format!("无法保存上传文件：{error}"))
    })();
    if let Err(error) = result {
        let _ = sftp.unlink(&temporary_path);
        return Err(error);
    }
    reporter.completed(transferred);
    Ok(())
}

fn remote_upload_temporary_path(remote_path: &Path, transfer_id: &str) -> Result<PathBuf, String> {
    let file_name = remote_path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "上传目标缺少文件名".to_string())?;
    let safe_transfer_id: String = transfer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    let safe_transfer_id = if safe_transfer_id.is_empty() {
        "transfer"
    } else {
        &safe_transfer_id
    };
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".{safe_transfer_id}.part"));
    Ok(remote_path.with_file_name(temporary_name))
}

fn download_file(sftp: &Sftp, task: &TransferTaskContext<'_>) -> Result<(), String> {
    let remote_path = Path::new(task.remote_path);
    let local_path = Path::new(task.local_path);
    if local_path.is_dir() {
        return Err("下载目标不能是文件夹".to_string());
    }
    if local_path.exists() && !task.overwrite {
        return Err("本地目标已存在，需要确认覆盖".to_string());
    }
    let parent = local_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(format!("下载目标目录不存在：{}", parent.display()));
    }
    let temporary_path = download_temporary_path(local_path, task.transfer_id)?;
    if temporary_path.exists() {
        fs::remove_file(&temporary_path)
            .map_err(|error| format!("无法清理上次未完成的下载文件：{error}"))?;
    }

    let total = sftp
        .stat(remote_path)
        .map_err(|error| format!("无法读取远程文件信息：{error}"))?
        .size
        .unwrap_or(0);
    let reporter = TransferReporter::new(
        task.app,
        task.session_id,
        task.transfer_id,
        "download",
        remote_path,
        total,
    );
    reporter.running(0);

    let mut source = sftp
        .open(remote_path)
        .map_err(|error| format!("无法打开远程文件：{error}"))?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| {
            format!(
                "无法在所选目录“{}”创建临时下载文件：{error}",
                parent.display()
            )
        })?;
    let mut transferred = 0_u64;
    let result = (|| -> Result<(), String> {
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
        loop {
            wait_for_transfer(task.control, &reporter, transferred)?;
            let size = source
                .read(&mut buffer)
                .map_err(|error| format!("读取远程文件失败：{error}"))?;
            if size == 0 {
                break;
            }
            target
                .write_all(&buffer[..size])
                .map_err(|error| format!("写入本地临时文件失败：{error}"))?;
            transferred += size as u64;
            reporter.running(transferred);
        }
        wait_for_transfer(task.control, &reporter, transferred)?;
        target
            .flush()
            .map_err(|error| format!("刷新本地临时文件失败：{error}"))?;
        drop(target);
        replace_download_file(&temporary_path, local_path, task.overwrite)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    reporter.completed(transferred);
    Ok(())
}

fn download_temporary_path(local_path: &Path, transfer_id: &str) -> Result<PathBuf, String> {
    let file_name = local_path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "下载目标缺少文件名".to_string())?;
    let safe_transfer_id: String = transfer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    let safe_transfer_id = if safe_transfer_id.is_empty() {
        "transfer"
    } else {
        &safe_transfer_id
    };
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".{safe_transfer_id}.part"));
    Ok(local_path.with_file_name(temporary_name))
}

fn replace_download_file(
    temporary_path: &Path,
    local_path: &Path,
    overwrite: bool,
) -> Result<(), String> {
    if local_path.exists() && !overwrite {
        return Err("本地目标已存在，需要确认覆盖".to_string());
    }
    #[cfg(target_os = "windows")]
    if local_path.exists() {
        fs::remove_file(local_path).map_err(|error| format!("无法覆盖现有本地文件：{error}"))?;
    }
    fs::rename(temporary_path, local_path).map_err(|error| format!("无法保存下载文件：{error}"))
}

fn run_session(
    manager: SftpSessionManager,
    session_id: String,
    session: Session,
    mut sftp: Sftp,
    receiver: Receiver<SftpCommand>,
    keep_alive_interval_seconds: u32,
) {
    loop {
        let command = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => {
                if keep_alive_interval_seconds > 0 && session.keepalive_send().is_err() {
                    break;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match command {
            SftpCommand::List { path, reply } => {
                let _ = reply.send(list_directory(&sftp, &path));
            }
            SftpCommand::CreateDirectory { path, reply } => {
                let result = sftp
                    .mkdir(Path::new(&path), 0o755)
                    .map_err(|error| format!("新建远程目录失败：{error}"));
                let _ = reply.send(result);
            }
            SftpCommand::CreateFile { path, reply } => {
                let _ = reply.send(create_empty_file(&sftp, &path));
            }
            SftpCommand::Rename {
                source_path,
                target_path,
                overwrite,
                reply,
            } => {
                let flags = if overwrite {
                    RenameFlags::OVERWRITE
                } else {
                    RenameFlags::empty()
                };
                let result = sftp
                    .rename(
                        Path::new(&source_path),
                        Path::new(&target_path),
                        Some(flags),
                    )
                    .map_err(|error| format!("重命名远程项目失败：{error}"));
                let _ = reply.send(result);
            }
            SftpCommand::Delete { path, reply } => {
                let result = sftp
                    .lstat(Path::new(&path))
                    .map_err(|error| format!("无法读取远程项目信息：{error}"))
                    .and_then(|stat| {
                        if stat.is_dir() {
                            sftp.rmdir(Path::new(&path))
                                .map_err(|error| format!("删除远程目录失败：{error}"))
                        } else {
                            sftp.unlink(Path::new(&path))
                                .map_err(|error| format!("删除远程文件失败：{error}"))
                        }
                    });
                let _ = reply.send(result);
            }
            SftpCommand::FastDelete { paths, reply } => {
                let _ = reply.send(fast_delete(&session, &paths));
            }
            SftpCommand::SetPermissions {
                path,
                permissions,
                reply,
            } => {
                let _ = reply.send(set_permissions(&sftp, &path, permissions));
            }
            SftpCommand::ReadTextFile { path, reply } => {
                let _ = reply.send(read_remote_text_file(&sftp, &path));
            }
            SftpCommand::WriteTextFile {
                path,
                content,
                original_content,
                overwrite,
                reply,
            } => {
                let _ = reply.send(write_remote_text_file(
                    &sftp,
                    &path,
                    content,
                    &original_content,
                    overwrite,
                ));
            }
            SftpCommand::Close => break,
        }
    }

    let _ = sftp.shutdown();
    manager.remove(&session_id);
}

fn connect_session(
    manager: SftpSessionManager,
    request: SftpConnectRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<SftpConnectResult, String> {
    let auth = SshAuthConfig {
        host_id: request.host_id,
        address: request.address,
        port: request.port,
        username: request.username,
        auth_method: request.auth_method,
        private_key_path: request.private_key_path,
        connect_timeout_seconds: request.connect_timeout_seconds,
        keep_alive_interval_seconds: request.keep_alive_interval_seconds,
        expected_fingerprint: request.expected_fingerprint,
        proxy: request.proxy,
        jump_host: request.jump_host,
    };
    let (session, fingerprint) = connect_authenticated_session(&auth, &cancelled)?;
    let mut sftp = session
        .sftp()
        .map_err(|error| format!("无法建立 SFTP 会话：{error}"))?;
    let home_dir = sftp
        .realpath(Path::new("."))
        .map_err(|error| format!("无法读取远程主目录：{error}"))?;
    if cancelled.load(Ordering::Acquire) {
        let _ = sftp.shutdown();
        return Err("SFTP 连接已取消".to_string());
    }

    let (sender, receiver) = mpsc::channel();
    manager.activate(&request.session_id, sender, auth.clone())?;
    let worker_manager = manager.clone();
    let worker_session_id = request.session_id.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("sftp-{}", request.session_id))
        .spawn(move || {
            run_session(
                worker_manager,
                worker_session_id,
                session,
                sftp,
                receiver,
                auth.keep_alive_interval_seconds,
            )
        })
    {
        manager.remove(&request.session_id);
        return Err(format!("无法启动 SFTP 会话线程：{error}"));
    }

    Ok(SftpConnectResult {
        fingerprint,
        home_dir: remote_path_text(&home_dir),
    })
}

async fn dispatch<T, F>(
    manager: SftpSessionManager,
    session_id: String,
    create_command: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Sender<Result<T, String>>) -> SftpCommand + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, receiver) = mpsc::channel();
        manager.send(&session_id, create_command(reply))?;
        receiver
            .recv()
            .map_err(|_| "SFTP 操作没有返回结果".to_string())?
    })
    .await
    .map_err(|error| format!("SFTP 操作任务异常结束：{error}"))?
}

async fn run_transfer_task<F>(
    manager: SftpSessionManager,
    session_id: String,
    transfer_id: String,
    task: F,
) -> Result<(), String>
where
    F: FnOnce(SshAuthConfig, Arc<TransferControl>) -> Result<(), String> + Send + 'static,
{
    let (auth, control) = manager.begin_transfer(&session_id, &transfer_id)?;
    let worker_manager = manager.clone();
    let worker_session_id = session_id.clone();
    let worker_transfer_id = transfer_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = task(auth, control);
        worker_manager.finish_transfer(&worker_session_id, &worker_transfer_id);
        result
    })
    .await;
    match result {
        Ok(result) => result,
        Err(error) => {
            manager.finish_transfer(&session_id, &transfer_id);
            Err(format!("SFTP 传输任务异常结束：{error}"))
        }
    }
}

fn report_transfer_result(
    reporter: &TransferReporter<'_>,
    control: &TransferControl,
    result: &Result<(), String>,
) {
    if let Err(error) = result {
        if control.cancelled.load(Ordering::Acquire) || error == TRANSFER_CANCELLED_ERROR {
            reporter.cancelled();
        } else {
            reporter.failed(error);
        }
    }
}

#[tauri::command]
pub(crate) async fn sftp_connect(
    manager: State<'_, SftpSessionManager>,
    request: SftpConnectRequest,
) -> Result<SftpConnectResult, String> {
    let manager = manager.inner().clone();
    let session_id = request.session_id.clone();
    let cancelled = manager.begin_connect(&session_id)?;
    let worker_manager = manager.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        connect_session(worker_manager, request, cancelled)
    })
    .await
    .map_err(|error| format!("SFTP 连接任务异常结束：{error}"))?;
    if result.is_err() {
        manager.remove(&session_id);
    }
    result
}

#[tauri::command]
pub(crate) async fn sftp_list(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<SftpListResult, String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::List { path, reply }
    })
    .await
}

#[tauri::command]
pub(crate) fn sftp_inspect_upload_paths(
    paths: Vec<String>,
) -> Result<Vec<LocalUploadFile>, String> {
    inspect_upload_paths(paths)
}

#[tauri::command]
pub(crate) async fn sftp_create_directory(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::CreateDirectory { path, reply }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_create_file(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::CreateFile { path, reply }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_rename(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    source_path: String,
    target_path: String,
    overwrite: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::Rename {
            source_path,
            target_path,
            overwrite,
            reply,
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_delete(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::Delete { path, reply }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_fast_delete(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::FastDelete { paths, reply }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_set_permissions(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
    permissions: u32,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::SetPermissions {
            path,
            permissions,
            reply,
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_read_text_file(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<SftpTextFile, String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::ReadTextFile { path, reply }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_write_text_file(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
    content: String,
    original_content: String,
    overwrite: bool,
) -> Result<SftpTextFile, String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::WriteTextFile {
            path,
            content,
            original_content,
            overwrite,
            reply,
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_upload(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
) -> Result<(), String> {
    let task_session_id = session_id.clone();
    let task_transfer_id = transfer_id.clone();
    run_transfer_task(
        manager.inner().clone(),
        session_id,
        transfer_id,
        move |auth, control| {
            let reporter = TransferReporter::new(
                &app,
                &task_session_id,
                &task_transfer_id,
                "upload",
                Path::new(&local_path),
                0,
            );
            let result = (|| -> Result<(), String> {
                let (session, _) = connect_authenticated_session(&auth, &control.cancelled)?;
                let mut sftp = session
                    .sftp()
                    .map_err(|error| format!("无法建立上传通道：{error}"))?;
                let task = TransferTaskContext {
                    app: &app,
                    session_id: &task_session_id,
                    control: &control,
                    transfer_id: &task_transfer_id,
                    local_path: &local_path,
                    remote_path: &remote_path,
                    overwrite,
                };
                let result = upload_file(&sftp, &task);
                let _ = sftp.shutdown();
                result
            })();
            report_transfer_result(&reporter, &control, &result);
            result
        },
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_download(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
) -> Result<(), String> {
    let task_session_id = session_id.clone();
    let task_transfer_id = transfer_id.clone();
    run_transfer_task(
        manager.inner().clone(),
        session_id,
        transfer_id,
        move |auth, control| {
            let reporter = TransferReporter::new(
                &app,
                &task_session_id,
                &task_transfer_id,
                "download",
                Path::new(&remote_path),
                0,
            );
            let result = (|| -> Result<(), String> {
                let (session, _) = connect_authenticated_session(&auth, &control.cancelled)?;
                let mut sftp = session
                    .sftp()
                    .map_err(|error| format!("无法建立下载通道：{error}"))?;
                let task = TransferTaskContext {
                    app: &app,
                    session_id: &task_session_id,
                    control: &control,
                    transfer_id: &task_transfer_id,
                    local_path: &local_path,
                    remote_path: &remote_path,
                    overwrite,
                };
                let result = download_file(&sftp, &task);
                let _ = sftp.shutdown();
                result
            })();
            report_transfer_result(&reporter, &control, &result);
            result
        },
    )
    .await
}

#[tauri::command]
pub(crate) fn sftp_pause_transfer(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    manager.transfer_control(&session_id, &transfer_id)?.pause()
}

#[tauri::command]
pub(crate) fn sftp_resume_transfer(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    manager
        .transfer_control(&session_id, &transfer_id)?
        .resume()
}

#[tauri::command]
pub(crate) fn sftp_cancel_transfer(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    manager
        .transfer_control(&session_id, &transfer_id)?
        .cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn sftp_disconnect(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.disconnect(&session_id)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{Read, Write},
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use ssh2::{FileStat, RenameFlags};

    use super::{
        decode_remote_text, download_temporary_path, entry_kind, fast_delete_command,
        inspect_upload_paths, remote_text_backup_path, remote_text_temporary_path,
        remote_upload_temporary_path, replace_download_file, shell_quote, SftpCommand,
        SftpSessionManager, REMOTE_TEXT_MAX_BYTES,
    };
    use crate::ssh::{connect_authenticated_session, SshAuthConfig, SshAuthMethod};

    fn test_auth() -> SshAuthConfig {
        SshAuthConfig {
            host_id: "host-1".to_string(),
            address: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: SshAuthMethod::Password,
            private_key_path: None,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 0,
            expected_fingerprint: None,
            proxy: None,
            jump_host: None,
        }
    }

    #[test]
    fn classifies_common_remote_entry_types() {
        let directory = FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o040755),
            atime: None,
            mtime: None,
        };
        let file = FileStat {
            perm: Some(0o100644),
            ..directory.clone()
        };

        assert_eq!(entry_kind(&directory), "directory");
        assert_eq!(entry_kind(&file), "file");
    }

    #[test]
    fn quotes_fast_delete_paths_without_shell_expansion() {
        assert_eq!(
            shell_quote("/tmp/report's draft"),
            "'/tmp/report'\"'\"'s draft'"
        );
        assert_eq!(
            fast_delete_command(&["/tmp/a b".to_string(), "/tmp/$HOME".to_string()]).unwrap(),
            "rm -rf -- '/tmp/a b' '/tmp/$HOME' 2>&1"
        );
    }

    #[test]
    fn protects_invalid_fast_delete_targets() {
        assert!(fast_delete_command(&[]).is_err());
        assert!(fast_delete_command(&["/".to_string()]).is_err());
        assert!(fast_delete_command(&["/./".to_string()]).is_err());
        assert!(fast_delete_command(&["/tmp/../data".to_string()]).is_err());
        assert!(fast_delete_command(&["relative/path".to_string()]).is_err());
    }

    #[test]
    fn keeps_partial_downloads_next_to_the_selected_file() {
        let target = Path::new("downloads/archive.zip");
        let temporary = download_temporary_path(target, "transfer-123").unwrap();
        assert_eq!(
            temporary,
            Path::new("downloads/.archive.zip.transfer-123.part")
        );
    }

    #[test]
    fn keeps_partial_uploads_next_to_the_remote_target() {
        let target = Path::new("/srv/releases/archive.zip");
        let temporary = remote_upload_temporary_path(target, "transfer-123").unwrap();
        assert_eq!(
            temporary,
            Path::new("/srv/releases/.archive.zip.transfer-123.part")
        );
    }

    #[test]
    fn validates_remote_text_editor_content() {
        assert_eq!(
            decode_remote_text("FineShell 中文\n".as_bytes().to_vec()).unwrap(),
            "FineShell 中文\n"
        );
        assert_eq!(
            decode_remote_text(b"text\0binary".to_vec()).unwrap_err(),
            "该文件包含二进制内容，无法作为文本编辑"
        );
        assert_eq!(
            decode_remote_text(vec![0xff, 0xfe]).unwrap_err(),
            "该文件不是有效的 UTF-8 文本"
        );
        assert!(decode_remote_text(vec![b'a'; REMOTE_TEXT_MAX_BYTES + 1])
            .unwrap_err()
            .contains("2 MiB"));
    }

    #[test]
    fn creates_a_hidden_remote_text_editor_temporary_path() {
        let temporary = remote_text_temporary_path(Path::new("/tmp/config.toml")).unwrap();
        let backup = remote_text_backup_path(Path::new("/tmp/config.toml")).unwrap();
        let file_name = temporary.file_name().unwrap().to_string_lossy();

        assert_eq!(temporary.parent(), Some(Path::new("/tmp")));
        assert!(file_name.starts_with(".config.toml.edit-"));
        assert!(file_name.ends_with(".part"));
        assert_eq!(
            backup,
            Path::new("/tmp/.config.toml.fineshell-edit-backup.part")
        );
    }

    #[test]
    fn keeps_only_regular_files_for_batch_uploads() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "fineshell-upload-inspect-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("report.txt");
        fs::write(&file, b"report").unwrap();

        let inspected = inspect_upload_paths(vec![
            file.to_string_lossy().into_owned(),
            directory.to_string_lossy().into_owned(),
            directory.join("missing.txt").to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(inspected.len(), 1);
        assert_eq!(inspected[0].name, "report.txt");
        assert_eq!(inspected[0].size, 6);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn replaces_an_existing_read_only_download_after_completion() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "fineshell-download-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let target = directory.join("archive.zip");
        let temporary = directory.join(".archive.zip.transfer.part");
        fs::write(&target, b"old").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).unwrap();
        fs::write(&temporary, b"new archive").unwrap();

        replace_download_file(&temporary, &target, true).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new archive");
        assert!(!temporary.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancels_a_connecting_sftp_session() {
        let manager = SftpSessionManager::default();
        let cancelled = manager.begin_connect("session-1").unwrap();

        manager.disconnect("session-1").unwrap();

        assert!(cancelled.load(Ordering::Acquire));
        let (sender, _) = std::sync::mpsc::channel();
        assert!(manager.activate("session-1", sender, test_auth()).is_err());
    }

    #[test]
    fn forwards_commands_to_an_active_sftp_session() {
        let manager = SftpSessionManager::default();
        manager.begin_connect("session-1").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        manager.activate("session-1", sender, test_auth()).unwrap();
        let (reply, _) = std::sync::mpsc::channel();

        manager
            .send(
                "session-1",
                SftpCommand::List {
                    path: "/tmp".to_string(),
                    reply,
                },
            )
            .unwrap();

        assert!(matches!(
            receiver.recv().unwrap(),
            SftpCommand::List { path, .. } if path == "/tmp"
        ));
    }

    #[test]
    fn controls_and_cancels_active_transfers() {
        let manager = SftpSessionManager::default();
        manager.begin_connect("session-1").unwrap();
        let (sender, _receiver) = std::sync::mpsc::channel();
        manager.activate("session-1", sender, test_auth()).unwrap();
        let (_auth, control) = manager.begin_transfer("session-1", "transfer-1").unwrap();

        control.pause().unwrap();
        assert!(*control.paused.lock().unwrap());
        control.resume().unwrap();
        assert!(!*control.paused.lock().unwrap());

        manager.disconnect("session-1").unwrap();
        assert!(control.cancelled.load(Ordering::Acquire));
    }

    #[test]
    #[ignore = "requires FINESHELL_LIVE_* environment variables and a stored password or test private key"]
    fn completes_a_live_sftp_round_trip() -> Result<(), String> {
        let host_id = std::env::var("FINESHELL_LIVE_HOST_ID")
            .map_err(|_| "缺少 FINESHELL_LIVE_HOST_ID".to_string())?;
        let address = std::env::var("FINESHELL_LIVE_ADDRESS")
            .map_err(|_| "缺少 FINESHELL_LIVE_ADDRESS".to_string())?;
        let port = std::env::var("FINESHELL_LIVE_PORT")
            .unwrap_or_else(|_| "22".to_string())
            .parse::<u16>()
            .map_err(|error| format!("FINESHELL_LIVE_PORT 无效：{error}"))?;
        let username =
            std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
        let expected_fingerprint = std::env::var("FINESHELL_LIVE_FINGERPRINT").ok();
        let private_key_path = std::env::var("FINESHELL_LIVE_PRIVATE_KEY").ok();
        let config = SshAuthConfig {
            host_id,
            address,
            port,
            username,
            auth_method: if private_key_path.is_some() {
                SshAuthMethod::PrivateKey
            } else {
                SshAuthMethod::Password
            },
            private_key_path,
            connect_timeout_seconds: 10,
            keep_alive_interval_seconds: 15,
            expected_fingerprint,
            proxy: None,
            jump_host: None,
        };
        let (session, _) = connect_authenticated_session(&config, &AtomicBool::new(false))?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("无法建立 SFTP 会话：{error}"))?;
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let directory = format!("/tmp/fineshell-live-{}-{suffix}", std::process::id());
        let source_path = format!("{directory}/source.txt");
        let renamed_path = format!("{directory}/renamed.txt");
        let content = b"FineShell live SFTP test\n";
        let edited_content = "FineShell live text editor test\n";

        sftp.mkdir(Path::new(&directory), 0o755)
            .map_err(|error| format!("创建测试目录失败：{error}"))?;
        let result = (|| -> Result<(), String> {
            let mut remote = sftp
                .create(Path::new(&source_path))
                .map_err(|error| format!("创建测试文件失败：{error}"))?;
            remote
                .write_all(content)
                .map_err(|error| format!("写入测试文件失败：{error}"))?;
            remote
                .flush()
                .map_err(|error| format!("刷新测试文件失败：{error}"))?;
            drop(remote);

            let entries = super::list_directory(&sftp, &directory)?;
            if !entries
                .entries
                .iter()
                .any(|entry| entry.name == "source.txt")
            {
                return Err("目录列表没有返回测试文件".to_string());
            }

            let opened = super::read_remote_text_file(&sftp, &source_path)?;
            if opened.content.as_bytes() != content {
                return Err("文本编辑器读取内容与上传内容不一致".to_string());
            }
            let saved = super::write_remote_text_file(
                &sftp,
                &source_path,
                edited_content.to_string(),
                &opened.content,
                false,
            )?;
            if saved.content != edited_content {
                return Err("文本编辑器保存内容无效".to_string());
            }
            let conflict = super::write_remote_text_file(
                &sftp,
                &source_path,
                "should-not-overwrite\n".to_string(),
                &opened.content,
                false,
            )
            .unwrap_err();
            if conflict != super::REMOTE_TEXT_CONFLICT_ERROR {
                return Err(format!("文本编辑器冲突检测结果无效：{conflict}"));
            }

            sftp.rename(
                Path::new(&source_path),
                Path::new(&renamed_path),
                Some(RenameFlags::empty()),
            )
            .map_err(|error| format!("重命名测试文件失败：{error}"))?;
            let mut remote = sftp
                .open(Path::new(&renamed_path))
                .map_err(|error| format!("打开测试文件失败：{error}"))?;
            let mut downloaded = Vec::new();
            remote
                .read_to_end(&mut downloaded)
                .map_err(|error| format!("读取测试文件失败：{error}"))?;
            if downloaded != edited_content.as_bytes() {
                return Err("下载内容与上传内容不一致".to_string());
            }
            Ok(())
        })();

        let _ = sftp.unlink(Path::new(&source_path));
        let _ = sftp.unlink(Path::new(&renamed_path));
        let _ = sftp.rmdir(Path::new(&directory));
        result
    }
}
