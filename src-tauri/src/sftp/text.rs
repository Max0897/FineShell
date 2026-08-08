pub(super) fn decode_remote_text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > REMOTE_TEXT_MAX_BYTES {
        return Err("远程文本文件超过 2 MiB，无法直接编辑".to_string());
    }
    if bytes.contains(&0) {
        return Err("该文件包含二进制内容，无法作为文本编辑".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "该文件不是有效的 UTF-8 文本".to_string())
}

pub(super) fn read_remote_text_file(sftp: &Sftp, path: &str) -> Result<SftpTextFile, String> {
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

pub(super) fn remote_text_temporary_path(remote_path: &Path) -> Result<PathBuf, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成远程临时文件名：{error}"))?
        .as_nanos();
    remote_upload_temporary_path(
        &remote_path_text(remote_path),
        &format!("edit-{}-{suffix}", std::process::id()),
    )
}

pub(super) fn remote_text_backup_path(remote_path: &Path) -> Result<PathBuf, String> {
    remote_upload_temporary_path(&remote_path_text(remote_path), "fineshell-edit-backup")
}

pub(super) fn replace_remote_text_file(
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

pub(super) fn write_remote_text_file(
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

pub(super) fn validate_ai_file_operation_content(content: &str, label: &str) -> Result<(), String> {
    if content.len() > REMOTE_TEXT_MAX_BYTES {
        return Err(format!("{label}超过 2 MiB 限制"));
    }
    if content.as_bytes().contains(&0) {
        return Err(format!("{label}包含空字符"));
    }
    Ok(())
}

pub(super) fn ai_file_operation_temporary_path(
    path: &Path,
    action: &str,
) -> Result<PathBuf, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成 AI 文件操作临时路径：{error}"))?
        .as_nanos();
    remote_upload_temporary_path(
        &remote_path_text(path),
        &format!("ai-{action}-{}-{suffix}", std::process::id()),
    )
}

pub(super) fn create_ai_remote_text_file(
    sftp: &Sftp,
    path: &str,
    content: String,
) -> Result<SftpTextFile, String> {
    validate_ai_file_operation_content(&content, "新建文件内容")?;
    let path = normalize_remote_operation_path(path)?;
    if path == "/" {
        return Err("禁止将远程根目录作为新建文件".to_string());
    }
    let remote_path = Path::new(&path);
    if remote_exists(sftp, remote_path) {
        return Err("远程目标已存在，已阻止新建文件".to_string());
    }
    let temporary_path = ai_file_operation_temporary_path(remote_path, "create")?;
    let result = (|| -> Result<SftpTextFile, String> {
        let mut temporary = sftp
            .open_mode(
                &temporary_path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
                0o644,
                OpenType::File,
            )
            .map_err(|error| format!("无法创建 AI 文件操作临时文件：{error}"))?;
        temporary
            .write_all(content.as_bytes())
            .map_err(|error| format!("无法写入 AI 新建文件内容：{error}"))?;
        temporary
            .flush()
            .map_err(|error| format!("无法刷新 AI 新建文件内容：{error}"))?;
        drop(temporary);
        sftp.rename(&temporary_path, remote_path, Some(RenameFlags::empty()))
            .map_err(|error| format!("无法保存 AI 新建文件，目标可能已存在：{error}"))?;
        let stat = sftp
            .lstat(remote_path)
            .map_err(|error| format!("无法确认 AI 新建文件状态：{error}"))?;
        Ok(SftpTextFile {
            path: path.clone(),
            size: content.len() as u64,
            content,
            modified_at: stat.mtime,
            permissions: stat.perm.map(|value| value & 0o7777),
        })
    })();
    if result.is_err() {
        let _ = sftp.unlink(&temporary_path);
    }
    result
}

pub(super) fn rename_ai_remote_text_file(
    sftp: &Sftp,
    source_path: &str,
    target_path: &str,
    expected_content: &str,
) -> Result<SftpTextFile, String> {
    validate_ai_file_operation_content(expected_content, "重命名文件快照")?;
    let source_path = normalize_remote_operation_path(source_path)?;
    let target_path = normalize_remote_operation_path(target_path)?;
    if source_path == "/" || target_path == "/" || source_path == target_path {
        return Err("AI 重命名路径无效".to_string());
    }
    if remote_exists(sftp, Path::new(&target_path)) {
        return Err("远程目标已存在，已阻止重命名".to_string());
    }
    let before = read_remote_text_file(sftp, &source_path)?;
    if before.content != expected_content {
        return Err(REMOTE_TEXT_CONFLICT_ERROR.to_string());
    }
    sftp.rename(
        Path::new(&source_path),
        Path::new(&target_path),
        Some(RenameFlags::empty()),
    )
    .map_err(|error| format!("AI 重命名远程文件失败：{error}"))?;
    match read_remote_text_file(sftp, &target_path) {
        Ok(after) if after.content == expected_content => Ok(after),
        verification => {
            let detail = verification
                .err()
                .unwrap_or_else(|| REMOTE_TEXT_CONFLICT_ERROR.to_string());
            match sftp.rename(
                Path::new(&target_path),
                Path::new(&source_path),
                Some(RenameFlags::empty()),
            ) {
                Ok(()) => Err(format!("{REMOTE_TEXT_CONFLICT_ERROR}：{detail}")),
                Err(restore_error) => Err(format!(
                    "{REMOTE_TEXT_CONFLICT_ERROR}；文件位于 {target_path}，自动恢复失败：{restore_error}"
                )),
            }
        }
    }
}

pub(super) fn delete_ai_remote_text_file(
    sftp: &Sftp,
    path: &str,
    expected_content: &str,
) -> Result<(), String> {
    validate_ai_file_operation_content(expected_content, "删除文件快照")?;
    let path = normalize_remote_operation_path(path)?;
    if path == "/" {
        return Err("禁止删除远程根目录".to_string());
    }
    let before = read_remote_text_file(sftp, &path)?;
    if before.content != expected_content {
        return Err(REMOTE_TEXT_CONFLICT_ERROR.to_string());
    }
    let remote_path = Path::new(&path);
    let temporary_path = ai_file_operation_temporary_path(remote_path, "delete")?;
    sftp.rename(remote_path, &temporary_path, Some(RenameFlags::empty()))
        .map_err(|error| format!("无法暂存待删除的远程文件：{error}"))?;
    let verification = read_remote_text_file(
        sftp,
        temporary_path
            .to_str()
            .ok_or_else(|| "AI 文件操作临时路径无效".to_string())?,
    );
    if !matches!(verification, Ok(ref file) if file.content == expected_content) {
        return match sftp.rename(&temporary_path, remote_path, Some(RenameFlags::empty())) {
            Ok(()) => Err(REMOTE_TEXT_CONFLICT_ERROR.to_string()),
            Err(restore_error) => Err(format!(
                "{REMOTE_TEXT_CONFLICT_ERROR}；文件保留在 {}，自动恢复失败：{restore_error}",
                temporary_path.display()
            )),
        };
    }
    sftp.unlink(&temporary_path)
        .map_err(|error| format!("无法删除已校验的远程文件：{error}"))?;
    if remote_exists(sftp, remote_path) || remote_exists(sftp, &temporary_path) {
        return Err("远程文件删除后的路径校验失败".to_string());
    }
    Ok(())
}

pub(super) fn apply_ai_sftp_file_operation(
    sftp: &Sftp,
    request: AiSftpFileOperationRequest,
) -> Result<AiSftpFileOperationResult, String> {
    let file = match request.operation {
        AiSftpFileOperationKind::Create => {
            if request.target_path.is_some() || request.expected_content.is_some() {
                return Err("AI 新建文件参数无效".to_string());
            }
            Some(create_ai_remote_text_file(
                sftp,
                &request.path,
                request
                    .content
                    .ok_or_else(|| "AI 新建文件缺少内容".to_string())?,
            )?)
        }
        AiSftpFileOperationKind::Rename => {
            if request.content.is_some() {
                return Err("AI 重命名参数无效".to_string());
            }
            Some(rename_ai_remote_text_file(
                sftp,
                &request.path,
                request
                    .target_path
                    .as_deref()
                    .ok_or_else(|| "AI 重命名缺少目标路径".to_string())?,
                request
                    .expected_content
                    .as_deref()
                    .ok_or_else(|| "AI 重命名缺少文件快照".to_string())?,
            )?)
        }
        AiSftpFileOperationKind::Delete => {
            if request.content.is_some() || request.target_path.is_some() {
                return Err("AI 删除文件参数无效".to_string());
            }
            delete_ai_remote_text_file(
                sftp,
                &request.path,
                request
                    .expected_content
                    .as_deref()
                    .ok_or_else(|| "AI 删除文件缺少文件快照".to_string())?,
            )?;
            None
        }
    };
    Ok(AiSftpFileOperationResult { file })
}
use super::*;
