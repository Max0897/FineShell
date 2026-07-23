use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sftp::{
    SftpSessionManager, SftpTextFile, REMOTE_TEXT_CONFLICT_ERROR, REMOTE_TEXT_MAX_BYTES,
};

const EXTERNAL_EDIT_EVENT: &str = "sftp-external-edit";
const SAVE_DEBOUNCE: Duration = Duration::from_millis(700);

#[derive(Clone)]
struct ExternalEditHandle {
    edit_id: String,
    session_id: String,
    remote_path: String,
    file_name: String,
    local_path: PathBuf,
    control: Sender<ExternalEditControl>,
}

enum ExternalEditControl {
    Overwrite(Sender<Result<(), String>>),
    Reload(Sender<Result<(), String>>),
    Close,
}

#[derive(Clone, Default)]
pub(crate) struct ExternalEditManager {
    edits: Arc<Mutex<HashMap<String, ExternalEditHandle>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalEditPayload {
    edit_id: String,
    session_id: String,
    remote_path: String,
    file_name: String,
    local_path: String,
    status: &'static str,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalEditResult {
    edit_id: String,
    local_path: String,
    created: bool,
}

impl ExternalEditManager {
    fn existing(&self, session_id: &str, remote_path: &str) -> Option<ExternalEditHandle> {
        self.edits.lock().ok()?.values().find_map(|edit| {
            (edit.session_id == session_id && edit.remote_path == remote_path).then(|| edit.clone())
        })
    }

    fn insert(&self, edit: ExternalEditHandle) -> Result<(), String> {
        self.edits
            .lock()
            .map_err(|_| "外部编辑任务状态不可用".to_string())?
            .insert(edit.edit_id.clone(), edit);
        Ok(())
    }

    fn get(&self, edit_id: &str) -> Result<ExternalEditHandle, String> {
        self.edits
            .lock()
            .map_err(|_| "外部编辑任务状态不可用".to_string())?
            .get(edit_id)
            .cloned()
            .ok_or_else(|| "外部编辑任务不存在或已结束".to_string())
    }

    fn remove(&self, edit_id: &str) {
        if let Ok(mut edits) = self.edits.lock() {
            edits.remove(edit_id);
        }
    }

    fn action(&self, edit_id: &str, action: &str) -> Result<(), String> {
        let edit = self.get(edit_id)?;
        match action {
            "overwrite" | "reload" => {
                let (reply, receiver) = mpsc::channel();
                let control = if action == "overwrite" {
                    ExternalEditControl::Overwrite(reply)
                } else {
                    ExternalEditControl::Reload(reply)
                };
                edit.control
                    .send(control)
                    .map_err(|_| "外部编辑任务已停止".to_string())?;
                receiver
                    .recv()
                    .map_err(|_| "外部编辑操作没有返回结果".to_string())?
            }
            "close" => edit
                .control
                .send(ExternalEditControl::Close)
                .map_err(|_| "外部编辑任务已停止".to_string()),
            _ => Err("未知的外部编辑操作".to_string()),
        }
    }
}

fn edit_result(edit: &ExternalEditHandle, created: bool) -> ExternalEditResult {
    ExternalEditResult {
        edit_id: edit.edit_id.clone(),
        local_path: edit.local_path.to_string_lossy().into_owned(),
        created,
    }
}

fn emit_status(
    app: &AppHandle,
    edit: &ExternalEditHandle,
    status: &'static str,
    error: Option<String>,
) {
    let _ = app.emit(
        EXTERNAL_EDIT_EVENT,
        ExternalEditPayload {
            edit_id: edit.edit_id.clone(),
            session_id: edit.session_id.clone(),
            remote_path: edit.remote_path.clone(),
            file_name: edit.file_name.clone(),
            local_path: edit.local_path.to_string_lossy().into_owned(),
            status,
            error,
        },
    );
}

fn make_edit_id() -> Result<String, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成外部编辑任务编号：{error}"))?
        .as_nanos();
    Ok(format!("external-edit-{}-{suffix}", std::process::id()))
}

fn set_private_permissions(path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("无法设置本地编辑缓存权限：{error}"))?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn create_local_cache(
    app: &AppHandle,
    edit_id: &str,
    remote_path: &str,
    content: &str,
) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法确定本地缓存目录：{error}"))?
        .join("external-edits")
        .join(edit_id);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("无法创建本地编辑缓存目录：{error}"))?;
    set_private_permissions(&cache_dir, true)?;
    let file_name = Path::new(remote_path)
        .file_name()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new("remote-file.txt"));
    let local_path = cache_dir.join(file_name);
    fs::write(&local_path, content)
        .map_err(|error| format!("无法创建本地编辑缓存文件：{error}"))?;
    set_private_permissions(&local_path, false)?;
    Ok(local_path)
}

fn read_local_text(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("无法读取本地编辑文件：{error}"))?;
    let mut bytes = Vec::new();
    file.take((REMOTE_TEXT_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取本地编辑文件：{error}"))?;
    if bytes.len() > REMOTE_TEXT_MAX_BYTES {
        return Err("本地编辑文件超过 2 MiB，无法自动同步".to_string());
    }
    if bytes.contains(&0) {
        return Err("本地编辑文件包含二进制内容，无法自动同步".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "本地编辑文件不是有效的 UTF-8 文本".to_string())
}

fn replace_local_text(path: &Path, content: &str) -> Result<(), String> {
    let temporary_path = path.with_extension("fineshell-reload.tmp");
    fs::write(&temporary_path, content)
        .map_err(|error| format!("无法更新本地编辑缓存：{error}"))?;
    set_private_permissions(&temporary_path, false)?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法替换本地编辑缓存：{error}"))?;
    }
    fs::rename(&temporary_path, path).map_err(|error| format!("无法替换本地编辑缓存：{error}"))
}

fn matches_local_file(event: &Event, local_path: &Path) -> bool {
    !matches!(event.kind, EventKind::Access(_)) && event.paths.iter().any(|path| path == local_path)
}

fn sync_local_file(
    app: &AppHandle,
    edit: &ExternalEditHandle,
    sftp: &SftpSessionManager,
    original_content: &mut String,
    overwrite: bool,
) -> Result<(), String> {
    let content = read_local_text(&edit.local_path)?;
    if content == *original_content {
        emit_status(app, edit, "synced", None);
        return Ok(());
    }
    emit_status(app, edit, "syncing", None);
    let updated = sftp.write_text_file(
        &edit.session_id,
        edit.remote_path.clone(),
        content,
        original_content.clone(),
        overwrite,
    )?;
    *original_content = updated.content;
    emit_status(app, edit, "synced", None);
    Ok(())
}

fn reload_local_file(
    app: &AppHandle,
    edit: &ExternalEditHandle,
    sftp: &SftpSessionManager,
    original_content: &mut String,
) -> Result<(), String> {
    let remote = sftp.read_text_file(&edit.session_id, edit.remote_path.clone())?;
    replace_local_text(&edit.local_path, &remote.content)?;
    *original_content = remote.content;
    emit_status(app, edit, "synced", None);
    Ok(())
}

struct ExternalEditWorker {
    app: AppHandle,
    registry: ExternalEditManager,
    edit: ExternalEditHandle,
    sftp: SftpSessionManager,
    original_content: String,
    receiver: Receiver<Result<Event, notify::Error>>,
    watcher: RecommendedWatcher,
    control: Receiver<ExternalEditControl>,
}

fn run_external_edit(worker: ExternalEditWorker) {
    let ExternalEditWorker {
        app,
        registry,
        edit,
        sftp,
        mut original_content,
        receiver,
        watcher: _watcher,
        control,
    } = worker;
    let mut pending_save: Option<Instant> = None;
    let mut conflicted = false;

    'worker: loop {
        while let Ok(message) = control.try_recv() {
            match message {
                ExternalEditControl::Overwrite(reply) => {
                    let result = sync_local_file(&app, &edit, &sftp, &mut original_content, true);
                    if result.is_ok() {
                        conflicted = false;
                    } else if let Err(error) = &result {
                        emit_status(&app, &edit, "failed", Some(error.clone()));
                    }
                    let _ = reply.send(result);
                }
                ExternalEditControl::Reload(reply) => {
                    let result = reload_local_file(&app, &edit, &sftp, &mut original_content);
                    if result.is_ok() {
                        conflicted = false;
                    } else if let Err(error) = &result {
                        emit_status(&app, &edit, "failed", Some(error.clone()));
                    }
                    let _ = reply.send(result);
                }
                ExternalEditControl::Close => break 'worker,
            }
        }

        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) if matches_local_file(&event, &edit.local_path) => {
                pending_save = Some(Instant::now());
            }
            Ok(Err(error)) => {
                emit_status(
                    &app,
                    &edit,
                    "failed",
                    Some(format!("本地文件监听失败：{error}")),
                );
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Ok(Ok(_)) | Err(RecvTimeoutError::Timeout) => {}
        }

        if !conflicted
            && pending_save.is_some_and(|changed_at| changed_at.elapsed() >= SAVE_DEBOUNCE)
        {
            pending_save = None;
            if let Err(error) = sync_local_file(&app, &edit, &sftp, &mut original_content, false) {
                conflicted = error.contains(REMOTE_TEXT_CONFLICT_ERROR);
                emit_status(
                    &app,
                    &edit,
                    if conflicted { "conflict" } else { "failed" },
                    Some(error),
                );
            }
        }
    }

    registry.remove(&edit.edit_id);
    emit_status(&app, &edit, "closed", None);
}

#[tauri::command]
pub(crate) async fn sftp_start_external_edit(
    app: AppHandle,
    edits: State<'_, ExternalEditManager>,
    sftp: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<ExternalEditResult, String> {
    if let Some(edit) = edits.existing(&session_id, &path) {
        return Ok(edit_result(&edit, false));
    }

    let worker_sftp = sftp.inner().clone();
    let read_session_id = session_id.clone();
    let read_path = path.clone();
    let document: SftpTextFile = tauri::async_runtime::spawn_blocking(move || {
        worker_sftp.read_text_file(&read_session_id, read_path)
    })
    .await
    .map_err(|error| format!("读取远程文件任务异常结束：{error}"))??;

    let edit_id = make_edit_id()?;
    let local_path = create_local_cache(&app, &edit_id, &path, &document.content)?;
    let watch_directory = local_path
        .parent()
        .ok_or_else(|| "无法确定本地编辑缓存目录".to_string())?
        .to_path_buf();
    let (event_sender, event_receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = event_sender.send(event);
    })
    .map_err(|error| format!("无法启动本地文件监听：{error}"))?;
    watcher
        .watch(&watch_directory, RecursiveMode::NonRecursive)
        .map_err(|error| format!("无法监听本地编辑文件：{error}"))?;

    let (control_sender, control_receiver) = mpsc::channel();
    let edit = ExternalEditHandle {
        edit_id,
        session_id,
        remote_path: path,
        file_name: local_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        local_path,
        control: control_sender,
    };
    edits.insert(edit.clone())?;
    emit_status(&app, &edit, "watching", None);

    let worker_registry = edits.inner().clone();
    let worker_edit = edit.clone();
    let worker_app = app.clone();
    let worker_sftp = sftp.inner().clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("external-edit-{}", edit.edit_id))
        .spawn(move || {
            run_external_edit(ExternalEditWorker {
                app: worker_app,
                registry: worker_registry,
                edit: worker_edit,
                sftp: worker_sftp,
                original_content: document.content,
                receiver: event_receiver,
                watcher,
                control: control_receiver,
            })
        })
    {
        edits.remove(&edit.edit_id);
        return Err(format!("无法启动外部编辑监听线程：{error}"));
    }

    Ok(edit_result(&edit, true))
}

#[tauri::command]
pub(crate) async fn sftp_external_edit_action(
    edits: State<'_, ExternalEditManager>,
    edit_id: String,
    action: String,
) -> Result<(), String> {
    let manager = edits.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.action(&edit_id, &action))
        .await
        .map_err(|error| format!("外部编辑操作异常结束：{error}"))?
}

#[tauri::command]
pub(crate) fn sftp_launch_external_editor(
    edits: State<'_, ExternalEditManager>,
    edit_id: String,
    editor_path: String,
) -> Result<(), String> {
    let edit = edits.get(&edit_id)?;
    let editor = PathBuf::from(editor_path);
    if !editor.is_absolute() || !editor.exists() {
        return Err("选择的外部编辑器不存在".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = if editor.is_dir()
        && editor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        let mut command = Command::new("/usr/bin/open");
        command.arg("-a").arg(&editor).arg(&edit.local_path);
        command
    } else {
        let mut command = Command::new(&editor);
        command.arg(&edit.local_path);
        command
    };

    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let mut command = Command::new(&editor);
        command.arg(&edit.local_path);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动外部编辑器：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_text_validation_rejects_oversized_and_binary_files() {
        let directory = std::env::temp_dir().join(make_edit_id().unwrap());
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.txt");

        fs::write(&path, vec![b'a'; REMOTE_TEXT_MAX_BYTES + 1]).unwrap();
        assert!(read_local_text(&path).unwrap_err().contains("超过 2 MiB"));

        fs::write(&path, b"hello\0world").unwrap();
        assert!(read_local_text(&path).unwrap_err().contains("二进制"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_text_validation_accepts_utf8() {
        let directory = std::env::temp_dir().join(make_edit_id().unwrap());
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.txt");
        fs::write(&path, "FineShell 外部编辑").unwrap();
        assert_eq!(read_local_text(&path).unwrap(), "FineShell 外部编辑");
        fs::remove_dir_all(directory).unwrap();
    }
}
