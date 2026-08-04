pub(super) fn remote_path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(super) fn entry_kind(stat: &FileStat) -> &'static str {
    match stat.file_type() {
        FileType::Directory => "directory",
        FileType::RegularFile => "file",
        FileType::Symlink => "symlink",
        _ => "other",
    }
}

#[derive(Default)]
pub(super) struct RemoteIdentityCache {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

pub(super) fn parse_identity_names(output: &str) -> HashMap<u32, String> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(':');
            let name = fields.next()?.trim();
            fields.next()?;
            let id = fields.next()?.parse::<u32>().ok()?;
            (!name.is_empty()).then(|| (id, name.to_string()))
        })
        .collect()
}

pub(super) fn query_identity_names(
    session: &Session,
    database: &str,
    ids: &[u32],
) -> HashMap<u32, String> {
    if ids.is_empty() {
        return HashMap::new();
    }

    let command = format!(
        "getent {database} {} 2>/dev/null || true",
        ids.iter().map(u32::to_string).collect::<Vec<_>>().join(" ")
    );
    let mut channel = match session.channel_session() {
        Ok(channel) => channel,
        Err(_) => return HashMap::new(),
    };
    if channel.exec(&command).is_err() {
        return HashMap::new();
    }

    let mut output = String::new();
    if channel.read_to_string(&mut output).is_err() {
        return HashMap::new();
    }
    let _ = channel.wait_close();

    parse_identity_names(&output)
}

pub(super) fn resolve_identity_names(
    session: &Session,
    entries: &[(PathBuf, FileStat)],
    cache: &mut RemoteIdentityCache,
) {
    let mut user_ids = entries
        .iter()
        .filter_map(|(_, stat)| stat.uid)
        .filter(|id| !cache.users.contains_key(id))
        .collect::<Vec<_>>();
    user_ids.sort_unstable();
    user_ids.dedup();

    let mut group_ids = entries
        .iter()
        .filter_map(|(_, stat)| stat.gid)
        .filter(|id| !cache.groups.contains_key(id))
        .collect::<Vec<_>>();
    group_ids.sort_unstable();
    group_ids.dedup();

    let user_names = query_identity_names(session, "passwd", &user_ids);
    for id in user_ids {
        cache.users.insert(
            id,
            user_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| id.to_string()),
        );
    }
    let group_names = query_identity_names(session, "group", &group_ids);
    for id in group_ids {
        cache.groups.insert(
            id,
            group_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| id.to_string()),
        );
    }
}

pub(super) fn list_directory(
    session: &Session,
    sftp: &Sftp,
    path: &str,
    identity_cache: &mut RemoteIdentityCache,
) -> Result<SftpListResult, String> {
    let canonical_path = sftp
        .realpath(Path::new(path))
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    let raw_entries = sftp
        .readdir(&canonical_path)
        .map_err(|error| format!("无法读取远程目录：{error}"))?;
    resolve_identity_names(session, &raw_entries, identity_cache);
    let mut entries = raw_entries
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
                owner: stat
                    .uid
                    .and_then(|id| identity_cache.users.get(&id).cloned()),
                group: stat
                    .gid
                    .and_then(|id| identity_cache.groups.get(&id).cloned()),
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

pub(super) fn remote_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

pub(super) fn local_upload_relative_path(path: &Path) -> Option<String> {
    let mut segments = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(segment) = component else {
            return None;
        };
        segments.push(segment.to_str()?.to_string());
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

pub(super) fn inspect_upload_directory(
    directory: &Path,
    relative_directory: &Path,
    inspection: &mut LocalUploadInspection,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            inspection.skipped_paths += 1;
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                inspection.skipped_paths += 1;
                continue;
            }
        };
        let metadata = match entry.path().symlink_metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                inspection.skipped_paths += 1;
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            inspection.skipped_paths += 1;
            continue;
        }
        let relative_path = relative_directory.join(entry.file_name());
        let Some(relative_path_text) = local_upload_relative_path(&relative_path) else {
            inspection.skipped_paths += 1;
            continue;
        };
        if metadata.is_dir() {
            inspection.directories.push(relative_path_text);
            inspect_upload_directory(&entry.path(), &relative_path, inspection);
        } else if metadata.is_file() {
            inspection.files.push(LocalUploadFile {
                path: entry.path().to_string_lossy().into_owned(),
                relative_path: relative_path_text,
                size: metadata.len(),
            });
        } else {
            inspection.skipped_paths += 1;
        }
    }
}

pub(super) fn inspect_upload_paths(paths: Vec<String>) -> Result<LocalUploadInspection, String> {
    if paths.is_empty() {
        return Err("没有选择需要上传的文件".to_string());
    }
    let mut inspection = LocalUploadInspection {
        files: Vec::new(),
        directories: Vec::new(),
        skipped_paths: 0,
    };
    let mut root_names = HashSet::new();
    for path in paths {
        let local_path = Path::new(&path);
        let metadata = match local_path.symlink_metadata() {
            Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
            _ => {
                inspection.skipped_paths += 1;
                continue;
            }
        };
        let Some(root_name) = local_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
        else {
            inspection.skipped_paths += 1;
            continue;
        };
        if !root_names.insert(root_name.clone()) {
            inspection.skipped_paths += 1;
            continue;
        }
        let root_relative = PathBuf::from(&root_name);
        if metadata.is_dir() {
            inspection.directories.push(root_name);
            inspect_upload_directory(local_path, &root_relative, &mut inspection);
        } else if metadata.is_file() {
            inspection.files.push(LocalUploadFile {
                path,
                relative_path: root_name,
                size: metadata.len(),
            });
        } else {
            inspection.skipped_paths += 1;
        }
    }
    inspection.directories.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then_with(|| left.cmp(right))
    });
    inspection.files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(inspection)
}

pub(super) fn ensure_upload_directories(
    sftp: &Sftp,
    base_path: &str,
    relative_paths: &[String],
) -> Result<(), String> {
    let base_path = normalize_remote_operation_path(base_path)?;
    let mut ensured = HashSet::new();
    for relative_path in relative_paths {
        let mut current = PathBuf::from(&base_path);
        for segment in relative_path.split('/') {
            if segment.is_empty() || matches!(segment, "." | "..") || segment.contains('\0') {
                return Err("本地目录包含无法上传的路径".to_string());
            }
            current.push(segment);
            let current_text = remote_path_text(&current);
            if !ensured.insert(current_text.clone()) {
                continue;
            }
            match sftp.lstat(&current) {
                Ok(stat) if stat.is_dir() => {}
                Ok(_) => return Err(format!("远程目标已存在同名文件：{current_text}")),
                Err(_) => sftp
                    .mkdir(&current, 0o755)
                    .map_err(|error| format!("无法创建远程目录 {current_text}：{error}"))?,
            }
        }
    }
    Ok(())
}

pub(super) fn create_empty_file(sftp: &Sftp, path: &str) -> Result<(), String> {
    sftp.open_mode(
        Path::new(path),
        OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
        0o644,
        OpenType::File,
    )
    .map(|_| ())
    .map_err(|error| format!("新建远程文件失败：{error}"))
}

pub(super) fn set_permissions(sftp: &Sftp, path: &str, permissions: u32) -> Result<(), String> {
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

pub(super) fn resolve_identity_id(
    session: &Session,
    database: &str,
    identity: &str,
    cache: &HashMap<u32, String>,
) -> Result<u32, String> {
    let identity = identity.trim();
    if identity.is_empty() || identity.len() > 128 || identity.chars().any(char::is_control) {
        return Err("用户或用户组名称无效".to_string());
    }
    if let Ok(id) = identity.parse::<u32>() {
        return Ok(id);
    }
    if let Some(id) = cache
        .iter()
        .find_map(|(id, name)| (name == identity).then_some(*id))
    {
        return Ok(id);
    }

    let command = format!(
        "getent {database} {} 2>/dev/null || true",
        shell_quote(identity)
    );
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法解析远程用户信息：{error}"))?;
    channel
        .exec(&command)
        .map_err(|error| format!("无法查询远程用户信息：{error}"))?;
    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| format!("无法读取远程用户信息：{error}"))?;
    let _ = channel.wait_close();

    parse_identity_names(&output)
        .into_keys()
        .next()
        .ok_or_else(|| {
            format!(
                "远程服务器不存在{}“{identity}”",
                if database == "passwd" {
                    "用户"
                } else {
                    "用户组"
                }
            )
        })
}

pub(super) fn set_owner(
    session: &Session,
    sftp: &Sftp,
    path: &str,
    owner: Option<&str>,
    group: Option<&str>,
    identity_cache: &mut RemoteIdentityCache,
) -> Result<(), String> {
    if owner.is_none() && group.is_none() {
        return Err("没有需要修改的用户或用户组".to_string());
    }

    let uid = owner
        .map(|value| resolve_identity_id(session, "passwd", value, &identity_cache.users))
        .transpose()?;
    let gid = group
        .map(|value| resolve_identity_id(session, "group", value, &identity_cache.groups))
        .transpose()?;
    sftp.setstat(
        Path::new(path),
        FileStat {
            size: None,
            uid,
            gid,
            perm: None,
            atime: None,
            mtime: None,
        },
    )
    .map_err(|error| format!("修改远程项目所有者失败：{error}"))?;

    if let (Some(id), Some(name)) = (uid, owner) {
        identity_cache.users.insert(id, name.to_string());
    }
    if let (Some(id), Some(name)) = (gid, group) {
        identity_cache.groups.insert(id, name.to_string());
    }
    Ok(())
}

pub(super) fn normalize_remote_operation_path(path: &str) -> Result<String, String> {
    if path.contains('\0') || !path.starts_with('/') {
        return Err("文件操作只允许使用有效的远程绝对路径".to_string());
    }

    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" => {}
            "." | ".." => return Err("文件操作路径不能包含相对路径片段".to_string()),
            value => segments.push(value),
        }
    }
    Ok(if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    })
}

pub(super) fn is_remote_descendant(parent: &str, candidate: &str) -> bool {
    candidate
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(super) fn copy_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    source_stat: &FileStat,
    overwrite: bool,
) -> Result<(), String> {
    let target_exists = sftp.lstat(target_path).ok();
    if target_exists.is_some() && !overwrite {
        return Err("远程目标已存在，需要确认覆盖".to_string());
    }
    if target_exists.as_ref().is_some_and(FileStat::is_dir) {
        return Err("无法用文件覆盖同名目录".to_string());
    }

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成远程复制临时文件名：{error}"))?
        .as_nanos();
    let temporary_path = remote_upload_temporary_path(
        target_path,
        &format!("copy-{}-{suffix}", std::process::id()),
    )?;
    if remote_exists(sftp, &temporary_path) {
        sftp.unlink(&temporary_path)
            .map_err(|error| format!("无法清理远程复制临时文件：{error}"))?;
    }

    let result = (|| -> Result<(), String> {
        let mut source = sftp
            .open(source_path)
            .map_err(|error| format!("无法打开待复制的远程文件：{error}"))?;
        let permissions = (source_stat.perm.unwrap_or(0o644) & 0o7777) as i32;
        let mut target = sftp
            .open_mode(
                &temporary_path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                permissions,
                OpenType::File,
            )
            .map_err(|error| format!("无法创建远程复制临时文件：{error}"))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
        loop {
            let size = source
                .read(&mut buffer)
                .map_err(|error| format!("读取待复制的远程文件失败：{error}"))?;
            if size == 0 {
                break;
            }
            target
                .write_all(&buffer[..size])
                .map_err(|error| format!("写入远程复制文件失败：{error}"))?;
        }
        target
            .flush()
            .map_err(|error| format!("刷新远程复制文件失败：{error}"))?;
        drop(target);
        sftp.setstat(
            &temporary_path,
            FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: source_stat.perm,
                atime: source_stat.atime,
                mtime: source_stat.mtime,
            },
        )
        .map_err(|error| format!("无法保留远程文件属性：{error}"))?;
        let flags = if target_exists.is_some() {
            RenameFlags::OVERWRITE
        } else {
            RenameFlags::empty()
        };
        sftp.rename(&temporary_path, target_path, Some(flags))
            .map_err(|error| format!("无法保存远程复制文件：{error}"))
    })();

    if result.is_err() {
        let _ = sftp.unlink(&temporary_path);
    }
    result
}

pub(super) fn copy_remote_directory(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    source_stat: &FileStat,
    overwrite: bool,
) -> Result<(), String> {
    match sftp.lstat(target_path) {
        Ok(_) if !overwrite => {
            return Err("远程目标已存在，需要确认覆盖".to_string());
        }
        Ok(target_stat) if !target_stat.is_dir() => {
            return Err("无法用目录覆盖同名文件".to_string());
        }
        Ok(_) => {}
        Err(_) => sftp
            .mkdir(
                target_path,
                (source_stat.perm.unwrap_or(0o755) & 0o7777) as i32,
            )
            .map_err(|error| format!("无法创建远程目标目录：{error}"))?,
    }

    let entries = sftp
        .readdir(source_path)
        .map_err(|error| format!("无法读取待复制的远程目录：{error}"))?;
    for (child_source, child_stat) in entries {
        let Some(name) = child_source.file_name() else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }
        let child_target = target_path.join(name);
        copy_remote_entry_inner(sftp, &child_source, &child_target, &child_stat, overwrite)?;
    }
    sftp.setstat(
        target_path,
        FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: source_stat.perm,
            atime: source_stat.atime,
            mtime: source_stat.mtime,
        },
    )
    .map_err(|error| format!("无法保留远程目录属性：{error}"))
}

pub(super) fn copy_remote_symlink(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    overwrite: bool,
) -> Result<(), String> {
    if let Ok(target_stat) = sftp.lstat(target_path) {
        if !overwrite {
            return Err("远程目标已存在，需要确认覆盖".to_string());
        }
        if target_stat.is_dir() {
            return Err("无法用符号链接覆盖同名目录".to_string());
        }
        sftp.unlink(target_path)
            .map_err(|error| format!("无法移除同名远程项目：{error}"))?;
    }
    let link_target = sftp
        .readlink(source_path)
        .map_err(|error| format!("无法读取远程符号链接：{error}"))?;
    sftp.symlink(&link_target, target_path)
        .map_err(|error| format!("无法复制远程符号链接：{error}"))
}

pub(super) fn copy_remote_entry_inner(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    source_stat: &FileStat,
    overwrite: bool,
) -> Result<(), String> {
    if source_stat.is_dir() {
        copy_remote_directory(sftp, source_path, target_path, source_stat, overwrite)
    } else if source_stat.is_file() {
        copy_remote_file(sftp, source_path, target_path, source_stat, overwrite)
    } else if source_stat.file_type() == FileType::Symlink {
        copy_remote_symlink(sftp, source_path, target_path, overwrite)
    } else {
        Err("暂不支持复制该类型的远程项目".to_string())
    }
}

pub(super) fn copy_remote_entry(
    sftp: &Sftp,
    source_path: &str,
    target_path: &str,
    overwrite: bool,
) -> Result<(), String> {
    let source_path = normalize_remote_operation_path(source_path)?;
    let target_path = normalize_remote_operation_path(target_path)?;
    if source_path == "/" || target_path == "/" {
        return Err("禁止复制远程根目录".to_string());
    }
    if source_path == target_path {
        return Err("源项目与目标项目不能相同".to_string());
    }

    let source = Path::new(&source_path);
    let target = Path::new(&target_path);
    let source_stat = sftp
        .lstat(source)
        .map_err(|error| format!("无法读取待复制的远程项目信息：{error}"))?;
    if source_stat.is_dir() && is_remote_descendant(&source_path, &target_path) {
        return Err("不能将目录复制到其自身内部".to_string());
    }
    copy_remote_entry_inner(sftp, source, target, &source_stat, overwrite)
}

pub(super) fn remove_remote_entry_recursive(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("无法读取待移除的远程项目信息：{error}"))?;
    if !stat.is_dir() {
        return sftp
            .unlink(path)
            .map_err(|error| format!("无法移除远程文件：{error}"));
    }

    let entries = sftp
        .readdir(path)
        .map_err(|error| format!("无法读取待移除的远程目录：{error}"))?;
    for (child_path, _) in entries {
        let Some(name) = child_path.file_name() else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }
        remove_remote_entry_recursive(sftp, &child_path)?;
    }
    sftp.rmdir(path)
        .map_err(|error| format!("无法移除远程目录：{error}"))
}

pub(super) fn move_remote_entry(
    sftp: &Sftp,
    source_path: &str,
    target_path: &str,
    overwrite: bool,
) -> Result<(), String> {
    let source_path = normalize_remote_operation_path(source_path)?;
    let target_path = normalize_remote_operation_path(target_path)?;
    if source_path == "/" || target_path == "/" {
        return Err("禁止移动远程根目录".to_string());
    }
    if source_path == target_path {
        return Err("源项目与目标项目不能相同".to_string());
    }

    let source = Path::new(&source_path);
    let target = Path::new(&target_path);
    let source_stat = sftp
        .lstat(source)
        .map_err(|error| format!("无法读取待移动的远程项目信息：{error}"))?;
    if source_stat.is_dir() && is_remote_descendant(&source_path, &target_path) {
        return Err("不能将目录移动到其自身内部".to_string());
    }
    if remote_exists(sftp, target) && !overwrite {
        return Err("远程目标已存在，需要确认覆盖".to_string());
    }

    let flags = if overwrite {
        RenameFlags::OVERWRITE
    } else {
        RenameFlags::empty()
    };
    match sftp.rename(source, target, Some(flags)) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_remote_entry(sftp, &source_path, &target_path, overwrite).map_err(
                |copy_error| {
                    format!("移动远程项目失败：{rename_error}；复制回退失败：{copy_error}")
                },
            )?;
            remove_remote_entry_recursive(sftp, source)
                .map_err(|remove_error| format!("目标项目已复制，但无法删除源项目：{remove_error}"))
        }
    }
}
use super::*;
