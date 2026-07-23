use std::{
    collections::HashMap,
    fs::{File as LocalFile, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use ssh2::{FileStat, FileType, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{connect_authenticated_session, SshAuthConfig, SshAuthMethod};
use crate::transport::ProxyConfig;

const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;

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
    Upload {
        transfer_id: String,
        local_path: String,
        remote_path: String,
        overwrite: bool,
        reply: Sender<Result<(), String>>,
    },
    Download {
        transfer_id: String,
        remote_path: String,
        local_path: String,
        overwrite: bool,
        reply: Sender<Result<(), String>>,
    },
    Close,
}

#[derive(Clone)]
enum SftpHandle {
    Connecting(Arc<AtomicBool>),
    Connected(Sender<SftpCommand>),
}

#[derive(Clone, Default)]
pub(crate) struct SftpSessionManager {
    sessions: Arc<Mutex<HashMap<String, SftpHandle>>>,
}

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

    fn activate(&self, session_id: &str, sender: Sender<SftpCommand>) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 会话状态不可用".to_string())?;
        match sessions.get(session_id) {
            Some(SftpHandle::Connecting(cancelled)) if !cancelled.load(Ordering::Acquire) => {
                sessions.insert(session_id.to_string(), SftpHandle::Connected(sender));
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
            SftpHandle::Connected(sender) => sender
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
        match handle {
            SftpHandle::Connecting(cancelled) => {
                cancelled.store(true, Ordering::Release);
                Ok(())
            }
            SftpHandle::Connected(sender) => sender
                .send(SftpCommand::Close)
                .map_err(|_| "SFTP 会话已停止".to_string()),
        }
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
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

    fn failed(&self, error: &str) {
        self.emit(0, "failed", Some(error.to_string()));
    }
}

fn upload_file(
    app: &AppHandle,
    session_id: &str,
    sftp: &Sftp,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<(), String> {
    let local_path = Path::new(local_path);
    let remote_path = Path::new(remote_path);
    let total = local_path
        .metadata()
        .map_err(|error| format!("无法读取本地文件信息：{error}"))?
        .len();
    if remote_exists(sftp, remote_path) && !overwrite {
        return Err("远程目标已存在，需要确认覆盖".to_string());
    }

    let reporter = TransferReporter::new(app, session_id, transfer_id, "upload", local_path, total);
    reporter.running(0);

    let mut source =
        LocalFile::open(local_path).map_err(|error| format!("无法打开本地文件：{error}"))?;
    let mut target = sftp
        .create(remote_path)
        .map_err(|error| format!("无法创建远程文件：{error}"))?;
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    let mut transferred = 0_u64;
    loop {
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
    target
        .flush()
        .map_err(|error| format!("刷新远程文件失败：{error}"))?;
    reporter.completed(transferred);
    Ok(())
}

fn download_file(
    app: &AppHandle,
    session_id: &str,
    sftp: &Sftp,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    overwrite: bool,
) -> Result<(), String> {
    let remote_path = Path::new(remote_path);
    let local_path = Path::new(local_path);
    if local_path.exists() && !overwrite {
        return Err("本地目标已存在，需要确认覆盖".to_string());
    }

    let total = sftp
        .stat(remote_path)
        .map_err(|error| format!("无法读取远程文件信息：{error}"))?
        .size
        .unwrap_or(0);
    let reporter =
        TransferReporter::new(app, session_id, transfer_id, "download", remote_path, total);
    reporter.running(0);

    let mut source = sftp
        .open(remote_path)
        .map_err(|error| format!("无法打开远程文件：{error}"))?;
    let mut target = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(local_path)
        .map_err(|error| format!("无法创建本地文件：{error}"))?;
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    let mut transferred = 0_u64;
    loop {
        let size = source
            .read(&mut buffer)
            .map_err(|error| format!("读取远程文件失败：{error}"))?;
        if size == 0 {
            break;
        }
        target
            .write_all(&buffer[..size])
            .map_err(|error| format!("写入本地文件失败：{error}"))?;
        transferred += size as u64;
        reporter.running(transferred);
    }
    target
        .flush()
        .map_err(|error| format!("刷新本地文件失败：{error}"))?;
    reporter.completed(transferred);
    Ok(())
}

fn run_session(
    app: AppHandle,
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
            SftpCommand::Upload {
                transfer_id,
                local_path,
                remote_path,
                overwrite,
                reply,
            } => {
                let result = upload_file(
                    &app,
                    &session_id,
                    &sftp,
                    &transfer_id,
                    &local_path,
                    &remote_path,
                    overwrite,
                );
                if let Err(error) = &result {
                    TransferReporter::new(
                        &app,
                        &session_id,
                        &transfer_id,
                        "upload",
                        Path::new(&local_path),
                        0,
                    )
                    .failed(error);
                }
                let _ = reply.send(result);
            }
            SftpCommand::Download {
                transfer_id,
                remote_path,
                local_path,
                overwrite,
                reply,
            } => {
                let result = download_file(
                    &app,
                    &session_id,
                    &sftp,
                    &transfer_id,
                    &remote_path,
                    &local_path,
                    overwrite,
                );
                if let Err(error) = &result {
                    TransferReporter::new(
                        &app,
                        &session_id,
                        &transfer_id,
                        "download",
                        Path::new(&remote_path),
                        0,
                    )
                    .failed(error);
                }
                let _ = reply.send(result);
            }
            SftpCommand::Close => break,
        }
    }

    let _ = sftp.shutdown();
    manager.remove(&session_id);
}

fn connect_session(
    app: AppHandle,
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
    manager.activate(&request.session_id, sender)?;
    let worker_manager = manager.clone();
    let worker_session_id = request.session_id.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("sftp-{}", request.session_id))
        .spawn(move || {
            run_session(
                app,
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

#[tauri::command]
pub(crate) async fn sftp_connect(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    request: SftpConnectRequest,
) -> Result<SftpConnectResult, String> {
    let manager = manager.inner().clone();
    let session_id = request.session_id.clone();
    let cancelled = manager.begin_connect(&session_id)?;
    let worker_manager = manager.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        connect_session(app, worker_manager, request, cancelled)
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_upload(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::Upload {
            transfer_id,
            local_path,
            remote_path,
            overwrite,
            reply,
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_download(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::Download {
            transfer_id,
            remote_path,
            local_path,
            overwrite,
            reply,
        }
    })
    .await
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
        io::{Read, Write},
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use ssh2::{FileStat, RenameFlags};

    use super::{entry_kind, fast_delete_command, shell_quote, SftpCommand, SftpSessionManager};
    use crate::ssh::{connect_authenticated_session, SshAuthConfig, SshAuthMethod};

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
    fn cancels_a_connecting_sftp_session() {
        let manager = SftpSessionManager::default();
        let cancelled = manager.begin_connect("session-1").unwrap();

        manager.disconnect("session-1").unwrap();

        assert!(cancelled.load(Ordering::Acquire));
        let (sender, _) = std::sync::mpsc::channel();
        assert!(manager.activate("session-1", sender).is_err());
    }

    #[test]
    fn forwards_commands_to_an_active_sftp_session() {
        let manager = SftpSessionManager::default();
        manager.begin_connect("session-1").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        manager.activate("session-1", sender).unwrap();
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
            if downloaded != content {
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
