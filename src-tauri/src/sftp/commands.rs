use super::*;
use tauri::State;

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

pub(crate) async fn agent_write_text_file(
    manager: SftpSessionManager,
    session_id: String,
    path: String,
    content: String,
    original_content: String,
) -> Result<SftpTextFile, String> {
    dispatch(manager, session_id, move |reply| {
        SftpCommand::WriteTextFile {
            path,
            content,
            original_content,
            overwrite: false,
            reply,
        }
    })
    .await
}

pub(crate) async fn agent_apply_file_operation(
    manager: SftpSessionManager,
    session_id: String,
    request: AiSftpFileOperationRequest,
) -> Result<AiSftpFileOperationResult, String> {
    dispatch(manager, session_id, move |reply| {
        SftpCommand::ApplyAiFileOperation { request, reply }
    })
    .await
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
pub(crate) async fn sftp_inspect_upload_paths(
    paths: Vec<String>,
) -> Result<LocalUploadInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_upload_paths(paths))
        .await
        .map_err(|error| format!("扫描本地上传目录任务异常结束：{error}"))?
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
pub(crate) async fn sftp_ensure_upload_directories(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    base_path: String,
    relative_paths: Vec<String>,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::EnsureUploadDirectories {
            base_path,
            relative_paths,
            reply,
        }
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
pub(crate) async fn sftp_copy(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    source_path: String,
    target_path: String,
    overwrite: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::Copy {
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
pub(crate) async fn sftp_set_owner(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
    owner: Option<String>,
    group: Option<String>,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::SetOwner {
            path,
            owner,
            group,
            reply,
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_create_archive(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    source_paths: Vec<String>,
    target_path: String,
    format: RemoteArchiveFormat,
    overwrite: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::CreateArchive {
            source_paths,
            target_path,
            format,
            overwrite,
            reply,
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn sftp_extract_archive(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    archive_path: String,
    target_directory: String,
    format: RemoteArchiveFormat,
    create_directory: bool,
) -> Result<(), String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::ExtractArchive {
            archive_path,
            target_directory,
            format,
            create_directory,
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
pub(crate) async fn sftp_apply_ai_file_operation(
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    request: AiSftpFileOperationRequest,
) -> Result<AiSftpFileOperationResult, String> {
    dispatch(manager.inner().clone(), session_id, move |reply| {
        SftpCommand::ApplyAiFileOperation { request, reply }
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_download_archive(
    app: AppHandle,
    manager: State<'_, SftpSessionManager>,
    session_id: String,
    transfer_id: String,
    source_paths: Vec<String>,
    archive_name: String,
    format: RemoteArchiveFormat,
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
                Path::new(&local_path),
                0,
            );
            let result = (|| -> Result<(), String> {
                let archive_name = validate_archive_file_name(&archive_name)?;
                let (session, _) = connect_authenticated_session(&auth, &control.cancelled)?;
                let mut sftp = session
                    .sftp()
                    .map_err(|error| format!("无法建立打包下载通道：{error}"))?;
                let temporary_directory = remote_archive_temporary_directory(&task_transfer_id);
                let remote_archive_path = remote_join_path(&temporary_directory, archive_name)?;
                let result = (|| -> Result<(), String> {
                    wait_for_transfer(&control, &reporter, 0)?;
                    let _ = sftp.unlink(Path::new(&remote_archive_path));
                    let _ = sftp.rmdir(Path::new(&temporary_directory));
                    sftp.mkdir(Path::new(&temporary_directory), 0o700)
                        .map_err(|error| format!("无法创建远程打包临时目录：{error}"))?;
                    create_archive(
                        &session,
                        &sftp,
                        &source_paths,
                        &remote_archive_path,
                        format,
                        false,
                    )?;
                    wait_for_transfer(&control, &reporter, 0)?;
                    let task = TransferTaskContext {
                        app: &app,
                        session_id: &task_session_id,
                        control: &control,
                        transfer_id: &task_transfer_id,
                        local_path: &local_path,
                        remote_path: &remote_archive_path,
                        overwrite,
                    };
                    download_file(&sftp, &task)
                })();
                let _ = sftp.unlink(Path::new(&remote_archive_path));
                let _ = sftp.rmdir(Path::new(&temporary_directory));
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
