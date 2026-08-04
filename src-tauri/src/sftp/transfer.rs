pub(super) fn emit_transfer(app: &AppHandle, payload: SftpTransferPayload) {
    let _ = app.emit_to("main", SFTP_TRANSFER_EVENT, payload);
}

pub(super) struct TransferReporter<'a> {
    app: &'a AppHandle,
    session_id: &'a str,
    transfer_id: &'a str,
    direction: &'static str,
    file_name: String,
    total_bytes: u64,
}

impl<'a> TransferReporter<'a> {
    pub(super) fn new(
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

    pub(super) fn emit(&self, transferred_bytes: u64, status: &'static str, error: Option<String>) {
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

    pub(super) fn running(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "running", None);
    }

    pub(super) fn completed(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "completed", None);
    }

    pub(super) fn paused(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "paused", None);
    }

    pub(super) fn cancelled(&self) {
        self.emit(0, "cancelled", None);
    }

    pub(super) fn failed(&self, error: &str) {
        self.emit(0, "failed", Some(error.to_string()));
    }
}

pub(super) fn wait_for_transfer(
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

pub(super) struct TransferTaskContext<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) session_id: &'a str,
    pub(super) control: &'a TransferControl,
    pub(super) transfer_id: &'a str,
    pub(super) local_path: &'a str,
    pub(super) remote_path: &'a str,
    pub(super) overwrite: bool,
}

pub(super) fn upload_file(sftp: &Sftp, task: &TransferTaskContext<'_>) -> Result<(), String> {
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

pub(super) fn remote_upload_temporary_path(
    remote_path: &Path,
    transfer_id: &str,
) -> Result<PathBuf, String> {
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

pub(super) fn download_file(sftp: &Sftp, task: &TransferTaskContext<'_>) -> Result<(), String> {
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

pub(super) fn download_temporary_path(
    local_path: &Path,
    transfer_id: &str,
) -> Result<PathBuf, String> {
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

pub(super) fn remote_archive_temporary_directory(transfer_id: &str) -> PathBuf {
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
    PathBuf::from(format!("/tmp/.fineshell-archive-{safe_transfer_id}"))
}

pub(super) fn replace_download_file(
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
use super::*;
