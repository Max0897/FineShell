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

    pub(super) fn waiting(&self, transferred_bytes: u64) {
        self.emit(transferred_bytes, "waiting", None);
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

struct NonblockingSessionGuard<'a> {
    session: &'a Session,
}

impl<'a> NonblockingSessionGuard<'a> {
    fn new(session: &'a Session) -> Self {
        session.set_blocking(false);
        Self { session }
    }
}

impl Drop for NonblockingSessionGuard<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(true);
    }
}

fn verified_upload_resume_offset(
    sftp: &Sftp,
    source: &mut LocalFile,
    temporary_path: &Path,
    total: u64,
) -> Result<u64, String> {
    if !remote_exists(sftp, temporary_path) {
        return Ok(0);
    }
    let stat = sftp
        .lstat(temporary_path)
        .map_err(|error| format!("无法读取未完成上传文件：{error}"))?;
    if stat.is_dir() {
        return Err("远程上传临时路径被目录占用".to_string());
    }
    let remote_size = stat.size.unwrap_or(0);
    if remote_size == 0 {
        return Ok(0);
    }
    if remote_size > total {
        sftp.unlink(temporary_path)
            .map_err(|error| format!("无法清理无效的未完成上传文件：{error}"))?;
        return Ok(0);
    }

    // A retry uses the same transfer id. Compare the trailing block before
    // resuming so a locally changed file cannot be appended to stale data.
    let verify_size = remote_size.min(TRANSFER_BUFFER_SIZE as u64) as usize;
    let verify_start = remote_size - verify_size as u64;
    let mut local_tail = vec![0_u8; verify_size];
    source
        .seek(SeekFrom::Start(verify_start))
        .and_then(|_| source.read_exact(&mut local_tail))
        .map_err(|error| format!("无法校验本地续传数据：{error}"))?;
    let mut remote = sftp
        .open(temporary_path)
        .map_err(|error| format!("无法打开未完成上传文件：{error}"))?;
    let mut remote_tail = vec![0_u8; verify_size];
    remote
        .seek(SeekFrom::Start(verify_start))
        .and_then(|_| remote.read_exact(&mut remote_tail))
        .map_err(|error| format!("无法校验远程续传数据：{error}"))?;
    drop(remote);
    if local_tail != remote_tail {
        sftp.unlink(temporary_path)
            .map_err(|error| format!("无法清理不匹配的未完成上传文件：{error}"))?;
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("无法重置本地上传文件：{error}"))?;
        return Ok(0);
    }
    source
        .seek(SeekFrom::Start(remote_size))
        .map_err(|error| format!("无法定位本地续传位置：{error}"))?;
    Ok(remote_size)
}

fn write_upload_buffer(
    target: &mut ssh2::File,
    buffer: &[u8],
    task: &TransferTaskContext<'_>,
    reporter: &TransferReporter<'_>,
    transferred: &mut u64,
) -> Result<(), String> {
    let mut offset = 0;
    let mut last_progress = Instant::now();
    let mut waiting_reported = false;
    while offset < buffer.len() {
        wait_for_transfer(task.control, reporter, *transferred)?;
        match target.write(&buffer[offset..]) {
            Ok(0) => {}
            Ok(written) => {
                offset += written;
                *transferred += written as u64;
                last_progress = Instant::now();
                waiting_reported = false;
                reporter.running(*transferred);
                continue;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("写入远程文件失败：{error}")),
        }

        let stalled_for = last_progress.elapsed();
        if stalled_for >= TRANSFER_IDLE_TIMEOUT {
            return Err(format!(
                "上传连续 {} 秒无进度，可能是网络中断或远程磁盘响应缓慢，可重试并继续上传",
                TRANSFER_IDLE_TIMEOUT.as_secs()
            ));
        }
        if !waiting_reported && stalled_for >= TRANSFER_WAITING_NOTICE {
            reporter.waiting(*transferred);
            waiting_reported = true;
        }
        thread::sleep(TRANSFER_RETRY_DELAY);
    }
    Ok(())
}

pub(super) fn upload_file(
    session: &Session,
    sftp: &Sftp,
    task: &TransferTaskContext<'_>,
) -> Result<(), String> {
    let local_path = Path::new(task.local_path);
    let remote_path_text = normalize_remote_operation_path(task.remote_path)?;
    let remote_path = Path::new(&remote_path_text);
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
    let temporary_path = remote_upload_temporary_path(&remote_path_text, task.transfer_id)?;

    let reporter = TransferReporter::new(
        task.app,
        task.session_id,
        task.transfer_id,
        "upload",
        local_path,
        total,
    );
    let mut transferred = 0_u64;
    let result = (|| -> Result<(), String> {
        let mut source =
            LocalFile::open(local_path).map_err(|error| format!("无法打开本地文件：{error}"))?;
        transferred = verified_upload_resume_offset(sftp, &mut source, &temporary_path, total)?;
        reporter.running(transferred);
        if transferred == total {
            return replace_remote_upload_file(
                sftp,
                &temporary_path,
                remote_path,
                task.overwrite,
                task.transfer_id,
            );
        }
        let mut target = if transferred == 0 {
            sftp.create(&temporary_path)
                .map_err(|error| format!("无法创建远程临时文件：{error}"))?
        } else {
            let mut target = sftp
                .open_mode(
                    &temporary_path,
                    OpenFlags::WRITE | OpenFlags::CREATE,
                    0o644,
                    OpenType::File,
                )
                .map_err(|error| format!("无法打开未完成上传文件：{error}"))?;
            target
                .seek(SeekFrom::Start(transferred))
                .map_err(|error| format!("无法定位远程续传位置：{error}"))?;
            target
        };
        let nonblocking = NonblockingSessionGuard::new(session);
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
        loop {
            wait_for_transfer(task.control, &reporter, transferred)?;
            let size = source
                .read(&mut buffer)
                .map_err(|error| format!("读取本地文件失败：{error}"))?;
            if size == 0 {
                break;
            }
            write_upload_buffer(
                &mut target,
                &buffer[..size],
                task,
                &reporter,
                &mut transferred,
            )?;
        }
        wait_for_transfer(task.control, &reporter, transferred)?;
        drop(nonblocking);
        target
            .flush()
            .map_err(|error| format!("刷新远程文件失败：{error}"))?;
        drop(target);
        replace_remote_upload_file(
            sftp,
            &temporary_path,
            remote_path,
            task.overwrite,
            task.transfer_id,
        )
    })();
    if let Err(error) = result {
        // Keep a non-empty part for retry. The next attempt verifies its
        // trailing block before resuming, so this does not depend on
        // server-specific timeout or disconnect error messages.
        if error == TRANSFER_CANCELLED_ERROR || transferred == 0 {
            let _ = sftp.unlink(&temporary_path);
        }
        return Err(error);
    }
    reporter.completed(transferred);
    Ok(())
}

pub(super) fn replace_remote_upload_file(
    sftp: &Sftp,
    temporary_path: &Path,
    remote_path: &Path,
    overwrite: bool,
    transfer_id: &str,
) -> Result<(), String> {
    let remote_path_text = remote_path_text(remote_path);
    let backup_path = remote_upload_temporary_path(
        &remote_path_text,
        &format!("{transfer_id}-overwrite-backup"),
    )?;

    // A retry may follow a process interruption after the original file was
    // moved aside but before the temporary upload was promoted.
    if !remote_exists(sftp, remote_path) && remote_exists(sftp, &backup_path) {
        sftp.rename(&backup_path, remote_path, Some(RenameFlags::empty()))
            .map_err(|error| {
                format!(
                    "检测到未完成的覆盖操作，但无法从 {} 恢复原文件：{error}",
                    backup_path.display()
                )
            })?;
    }

    let target_stat = sftp.lstat(remote_path).ok();
    if target_stat.as_ref().is_some_and(FileStat::is_dir) {
        return Err("无法用文件覆盖同名目录".to_string());
    }
    if target_stat.is_none() {
        return sftp
            .rename(temporary_path, remote_path, Some(RenameFlags::empty()))
            .map_err(|error| format!("无法保存上传文件：{error}"));
    }
    if !overwrite {
        return Err("远程目标已存在，需要确认覆盖".to_string());
    }

    if remote_exists(sftp, &backup_path) {
        sftp.unlink(&backup_path)
            .map_err(|error| format!("无法清理上次上传备份：{error}"))?;
    }
    sftp.rename(remote_path, &backup_path, Some(RenameFlags::empty()))
        .map_err(|error| format!("无法备份原远程文件：{error}"))?;

    if let Err(save_error) = sftp.rename(temporary_path, remote_path, Some(RenameFlags::empty())) {
        return match sftp.rename(&backup_path, remote_path, Some(RenameFlags::empty())) {
            Ok(()) => Err(format!("无法保存上传文件：{save_error}")),
            Err(restore_error) => Err(format!(
                "无法保存上传文件：{save_error}；原文件保留在 {}，自动恢复失败：{restore_error}",
                backup_path.display()
            )),
        };
    }

    // The uploaded file is already in place. A stale hidden backup should not
    // make the completed transfer look failed to the user.
    let _ = sftp.unlink(&backup_path);
    Ok(())
}

pub(super) fn remote_upload_temporary_path(
    remote_path: &str,
    transfer_id: &str,
) -> Result<PathBuf, String> {
    let remote_path = normalize_remote_operation_path(remote_path)?;
    let file_name =
        remote_file_name(&remote_path).ok_or_else(|| "上传目标缺少文件名".to_string())?;
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
    let temporary_name = format!(".{file_name}.{safe_transfer_id}.part");
    Ok(PathBuf::from(remote_sibling_path(
        &remote_path,
        &temporary_name,
    )?))
}

pub(super) fn download_file(sftp: &Sftp, task: &TransferTaskContext<'_>) -> Result<(), String> {
    let remote_path_text = normalize_remote_operation_path(task.remote_path)?;
    let remote_path = Path::new(&remote_path_text);
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

pub(super) fn remote_archive_temporary_directory(transfer_id: &str) -> String {
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
    format!("/tmp/.fineshell-archive-{safe_transfer_id}")
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
