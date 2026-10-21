use crate::remote_shell::{run_script_cancellable, shell_quote};

pub(super) fn execute_remote_command(
    session: &Session,
    command: &str,
    action: &str,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    let (output, exit_status) = run_script_cancellable(session, command, action, cancelled)
        .map_err(|error| {
            if cancelled.load(Ordering::Acquire) {
                TRANSFER_CANCELLED_ERROR.to_string()
            } else {
                error
            }
        })?;
    if exit_status == 0 {
        Ok(output)
    } else {
        let detail = output.trim();
        Err(if detail.is_empty() {
            format!("{action}命令异常退出：{exit_status}")
        } else {
            format!("{action}失败：{detail}")
        })
    }
}

pub(super) fn require_remote_commands(
    session: &Session,
    commands: &[&str],
    cancelled: &AtomicBool,
) -> Result<(), String> {
    for command in commands {
        let probe = format!("command -v {command} >/dev/null 2>&1");
        match execute_remote_command(session, &probe, "检查归档工具", cancelled) {
            Ok(_) => {}
            Err(error) if error == TRANSFER_CANCELLED_ERROR => return Err(error),
            Err(_) => return Err(format!("远程服务器未安装 {command} 命令")),
        }
    }
    Ok(())
}

pub(super) fn archive_source_parts(
    source_paths: &[String],
) -> Result<(String, Vec<String>), String> {
    if source_paths.is_empty() {
        return Err("没有选择需要归档的远程项目".to_string());
    }

    let mut parent_directory = None;
    let mut names = Vec::with_capacity(source_paths.len());
    for source_path in source_paths {
        let normalized = normalize_remote_operation_path(source_path)?;
        let parent =
            remote_parent_path(&normalized).ok_or_else(|| "归档源路径缺少父目录".to_string())?;
        let name =
            remote_file_name(&normalized).ok_or_else(|| "不能直接归档远程根目录".to_string())?;
        if let Some(expected_parent) = &parent_directory {
            if expected_parent != &parent {
                return Err("只能归档同一目录下的远程项目".to_string());
            }
        } else {
            parent_directory = Some(parent);
        }
        names.push(name);
    }
    names.sort();
    names.dedup();
    Ok((parent_directory.unwrap_or_else(|| "/".to_string()), names))
}

pub(super) fn validate_archive_file_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("归档文件名称无效".to_string());
    }
    Ok(name)
}

pub(super) fn remote_archive_creation_temporary_path(target_path: &str) -> Result<PathBuf, String> {
    let target_path = normalize_remote_operation_path(target_path)?;
    let file_name =
        remote_file_name(&target_path).ok_or_else(|| "归档目标缺少文件名".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary_name = format!(".fineshell-{nonce}-{file_name}");
    Ok(PathBuf::from(remote_sibling_path(
        &target_path,
        &temporary_name,
    )?))
}

pub(super) fn archive_create_command(
    source_paths: &[String],
    target_path: &str,
    format: RemoteArchiveFormat,
) -> Result<String, String> {
    let (parent_directory, names) = archive_source_parts(source_paths)?;
    let target_path = normalize_remote_operation_path(target_path)?;
    if source_paths.iter().any(|source| {
        normalize_remote_operation_path(source)
            .ok()
            .is_some_and(|source| {
                source == target_path || is_remote_descendant(&source, &target_path)
            })
    }) {
        return Err("归档目标不能与源项目相同".to_string());
    }
    let source_arguments = names
        .iter()
        .map(|name| shell_quote(name))
        .collect::<Vec<_>>()
        .join(" ");
    let parent = shell_quote(&parent_directory);
    let target = shell_quote(&target_path);
    Ok(match format {
        RemoteArchiveFormat::TarGz => {
            format!("tar -czf {target} -C {parent} -- {source_arguments} 2>&1")
        }
        RemoteArchiveFormat::Tar => {
            format!("tar -cf {target} -C {parent} -- {source_arguments} 2>&1")
        }
        RemoteArchiveFormat::Zip => {
            format!("cd {parent} && zip -rq {target} -- {source_arguments} 2>&1")
        }
    })
}

pub(super) fn create_archive(
    session: &Session,
    sftp: &Sftp,
    source_paths: &[String],
    target_path: &str,
    format: RemoteArchiveFormat,
    overwrite: bool,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let target_path = normalize_remote_operation_path(target_path)?;
    let target = Path::new(&target_path);
    validate_archive_file_name(
        &remote_file_name(&target_path).ok_or_else(|| "归档目标缺少有效文件名".to_string())?,
    )?;
    if remote_exists(sftp, target) && !overwrite {
        return Err("归档目标已存在，需要确认覆盖".to_string());
    }
    match format {
        RemoteArchiveFormat::TarGz => {
            require_remote_commands(session, &["tar", "gzip"], cancelled)?
        }
        RemoteArchiveFormat::Tar => require_remote_commands(session, &["tar"], cancelled)?,
        RemoteArchiveFormat::Zip => require_remote_commands(session, &["zip"], cancelled)?,
    }
    let temporary_path = remote_archive_creation_temporary_path(&target_path)?;
    let temporary_path_text = remote_path_text(&temporary_path);
    let command = archive_create_command(source_paths, &temporary_path_text, format)?;
    let result =
        execute_remote_command(session, &command, "压缩远程项目", cancelled).and_then(|_| {
            sftp.rename(
                &temporary_path,
                target,
                Some(if overwrite {
                    RenameFlags::OVERWRITE
                } else {
                    RenameFlags::empty()
                }),
            )
            .map_err(|error| format!("无法保存远程归档文件：{error}"))
        });
    if result.is_err() {
        let _ = sftp.unlink(&temporary_path);
    }
    result
}

pub(super) fn archive_listing_is_safe(output: &str) -> bool {
    output.lines().all(|entry| {
        let normalized = entry.trim().replace('\\', "/");
        !normalized.starts_with('/') && normalized.split('/').all(|component| component != "..")
    })
}

pub(super) fn extract_archive(
    session: &Session,
    sftp: &Sftp,
    archive_path: &str,
    target_directory: &str,
    format: RemoteArchiveFormat,
    create_directory: bool,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let archive_path = normalize_remote_operation_path(archive_path)?;
    let target_directory = normalize_remote_operation_path(target_directory)?;
    let target = Path::new(&target_directory);
    if create_directory {
        if remote_exists(sftp, target) {
            return Err("解压目标目录已存在".to_string());
        }
    } else {
        let target_stat = sftp
            .stat(target)
            .map_err(|error| format!("无法读取解压目标目录：{error}"))?;
        if !target_stat.is_dir() {
            return Err("解压目标不是目录".to_string());
        }
    }

    let archive = shell_quote(&archive_path);
    let destination = shell_quote(&target_directory);
    let (listing_command, extract_command) = match format {
        RemoteArchiveFormat::TarGz => {
            require_remote_commands(session, &["tar", "gzip"], cancelled)?;
            (
                format!("tar -tzf {archive} 2>&1"),
                format!("tar -xzf {archive} -C {destination} 2>&1"),
            )
        }
        RemoteArchiveFormat::Tar => {
            require_remote_commands(session, &["tar"], cancelled)?;
            (
                format!("tar -tf {archive} 2>&1"),
                format!("tar -xf {archive} -C {destination} 2>&1"),
            )
        }
        RemoteArchiveFormat::Zip => {
            require_remote_commands(session, &["unzip"], cancelled)?;
            (
                format!("unzip -Z1 {archive} 2>&1"),
                format!("unzip -oq {archive} -d {destination} 2>&1"),
            )
        }
    };
    let listing = execute_remote_command(session, &listing_command, "检查归档内容", cancelled)?;
    if !archive_listing_is_safe(&listing) {
        return Err("归档包含不安全的绝对路径或上级目录，已拒绝解压".to_string());
    }
    if create_directory {
        sftp.mkdir(target, 0o755)
            .map_err(|error| format!("无法创建解压目标目录：{error}"))?;
    }
    execute_remote_command(session, &extract_command, "解压远程归档", cancelled).map(|_| ())
}

pub(super) fn fast_delete_command(paths: &[String]) -> Result<String, String> {
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

pub(super) fn fast_delete(session: &Session, paths: &[String]) -> Result<(), String> {
    let command = fast_delete_command(paths)?;
    execute_remote_command(session, &command, "快速删除", &AtomicBool::new(false)).map(|_| ())
}
use super::*;
