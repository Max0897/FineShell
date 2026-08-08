pub(super) fn run_session(
    manager: SftpSessionManager,
    session_id: String,
    session: Session,
    mut sftp: Sftp,
    receiver: Receiver<SftpCommand>,
    keep_alive_interval_seconds: u32,
) {
    let mut identity_cache = RemoteIdentityCache::default();
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
                let _ = reply.send(list_directory(&session, &sftp, &path, &mut identity_cache));
            }
            SftpCommand::CreateDirectory { path, reply } => {
                let result = normalize_remote_operation_path(&path).and_then(|path| {
                    if path == "/" {
                        return Err("禁止将远程根目录作为新建目录".to_string());
                    }
                    sftp.mkdir(Path::new(&path), 0o755)
                        .map_err(|error| format!("新建远程目录失败：{error}"))
                });
                let _ = reply.send(result);
            }
            SftpCommand::EnsureUploadDirectories {
                base_path,
                relative_paths,
                reply,
            } => {
                let _ = reply.send(ensure_upload_directories(
                    &sftp,
                    &base_path,
                    &relative_paths,
                ));
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
                let _ = reply.send(move_remote_entry(
                    &sftp,
                    &source_path,
                    &target_path,
                    overwrite,
                ));
            }
            SftpCommand::Copy {
                source_path,
                target_path,
                overwrite,
                reply,
            } => {
                let _ = reply.send(copy_remote_entry(
                    &sftp,
                    &source_path,
                    &target_path,
                    overwrite,
                ));
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
            SftpCommand::SetOwner {
                path,
                owner,
                group,
                reply,
            } => {
                let _ = reply.send(set_owner(
                    &session,
                    &sftp,
                    &path,
                    owner.as_deref(),
                    group.as_deref(),
                    &mut identity_cache,
                ));
            }
            SftpCommand::CreateArchive {
                source_paths,
                target_path,
                format,
                overwrite,
                reply,
            } => {
                let _ = reply.send(create_archive(
                    &session,
                    &sftp,
                    &source_paths,
                    &target_path,
                    format,
                    overwrite,
                ));
            }
            SftpCommand::ExtractArchive {
                archive_path,
                target_directory,
                format,
                create_directory,
                reply,
            } => {
                let _ = reply.send(extract_archive(
                    &session,
                    &sftp,
                    &archive_path,
                    &target_directory,
                    format,
                    create_directory,
                ));
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
            SftpCommand::ApplyAiFileOperation { request, reply } => {
                let _ = reply.send(apply_ai_sftp_file_operation(&sftp, request));
            }
            SftpCommand::Close => break,
        }
    }

    let _ = sftp.shutdown();
    manager.remove(&session_id);
}

pub(super) fn connect_session(
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
use super::*;
