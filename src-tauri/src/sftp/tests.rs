use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use ssh2::FileStat;

use super::{
    archive_create_command, archive_listing_is_safe, decode_remote_text, download_temporary_path,
    entry_kind, fast_delete_command, inspect_upload_paths, is_remote_descendant,
    normalize_remote_operation_path, parse_identity_names, remote_archive_temporary_directory,
    remote_text_backup_path, remote_text_temporary_path, remote_upload_temporary_path,
    replace_download_file, shell_quote, validate_ai_file_operation_content,
    validate_archive_file_name, AiSftpFileOperationKind, AiSftpFileOperationRequest,
    RemoteArchiveFormat, RemoteIdentityCache, SftpCommand, SftpSessionManager,
    REMOTE_TEXT_MAX_BYTES,
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
fn deserializes_and_bounds_ai_file_operation_requests() {
    let request = serde_json::from_str::<AiSftpFileOperationRequest>(
            r#"{"operation":"rename","path":"/etc/app.conf","targetPath":"/etc/app.old.conf","expectedContent":"port=80\n"}"#,
        )
        .unwrap();
    assert_eq!(request.operation, AiSftpFileOperationKind::Rename);
    assert_eq!(request.path, "/etc/app.conf");
    assert_eq!(request.target_path.as_deref(), Some("/etc/app.old.conf"));
    assert_eq!(request.expected_content.as_deref(), Some("port=80\n"));
    assert!(serde_json::from_str::<AiSftpFileOperationRequest>(
        r#"{"operation":"delete","path":"/etc/app.conf","unexpected":true}"#,
    )
    .is_err());
    assert!(validate_ai_file_operation_content("plain text", "内容").is_ok());
    assert!(validate_ai_file_operation_content("binary\0text", "内容").is_err());
    assert!(
        validate_ai_file_operation_content(&"x".repeat(REMOTE_TEXT_MAX_BYTES + 1), "内容").is_err()
    );
}

#[test]
fn parses_user_and_group_identity_records() {
    let identities = parse_identity_names(
        "root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n",
    );

    assert_eq!(identities.get(&0).map(String::as_str), Some("root"));
    assert_eq!(identities.get(&33).map(String::as_str), Some("www-data"));
}

#[test]
fn builds_archive_commands_with_quoted_same_directory_sources() {
    let command = archive_create_command(
        &[
            "/srv/releases/a b".to_string(),
            "/srv/releases/report's.txt".to_string(),
        ],
        "/srv/releases/bundle.tar.gz",
        RemoteArchiveFormat::TarGz,
    )
    .unwrap();

    assert_eq!(
            command,
            "tar -czf '/srv/releases/bundle.tar.gz' -C '/srv/releases' -- 'a b' 'report'\"'\"'s.txt' 2>&1"
        );
    assert!(archive_create_command(
        &["/srv/a".to_string(), "/tmp/b".to_string()],
        "/srv/archive.zip",
        RemoteArchiveFormat::Zip,
    )
    .is_err());
    assert!(archive_create_command(
        &["/srv/releases".to_string()],
        "/srv/releases/archive.tar",
        RemoteArchiveFormat::Tar,
    )
    .is_err());
}

#[test]
fn rejects_unsafe_archive_entries_and_names() {
    assert!(archive_listing_is_safe("folder/\nfolder/report.txt\n"));
    assert!(!archive_listing_is_safe("../etc/passwd\n"));
    assert!(!archive_listing_is_safe("folder/../../etc/passwd\n"));
    assert!(!archive_listing_is_safe("/etc/passwd\n"));
    assert!(validate_archive_file_name("backup.tar.gz").is_ok());
    assert!(validate_archive_file_name("../backup.tar.gz").is_err());
}

#[test]
fn sanitizes_archive_download_temporary_directories() {
    assert_eq!(
        remote_archive_temporary_directory("transfer/../../123"),
        "/tmp/.fineshell-archive-transfer123"
    );
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
fn validates_remote_copy_paths_and_descendants() {
    assert_eq!(
        normalize_remote_operation_path("/srv//releases/archive.zip").unwrap(),
        "/srv/releases/archive.zip"
    );
    assert!(normalize_remote_operation_path("relative/path").is_err());
    assert!(normalize_remote_operation_path("/srv/../root").is_err());
    assert!(is_remote_descendant("/srv/releases", "/srv/releases/2026"));
    assert!(!is_remote_descendant("/srv/releases", "/srv/releases-old"));
    assert!(!is_remote_descendant("/srv/releases", "/srv/releases"));
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
    let temporary = remote_upload_temporary_path(target.to_str().unwrap(), "transfer-123").unwrap();
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
fn inspects_files_directories_and_empty_directories_for_batch_uploads() {
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
    let folder = directory.join("assets");
    let empty_folder = folder.join("empty");
    fs::create_dir_all(&empty_folder).unwrap();
    fs::write(folder.join("logo.txt"), b"logo").unwrap();

    let inspected = inspect_upload_paths(vec![
        file.to_string_lossy().into_owned(),
        folder.to_string_lossy().into_owned(),
        directory.join("missing.txt").to_string_lossy().into_owned(),
    ])
    .unwrap();

    assert_eq!(inspected.skipped_paths, 1);
    assert_eq!(inspected.directories, vec!["assets", "assets/empty"]);
    assert_eq!(inspected.files.len(), 2);
    assert_eq!(inspected.files[0].relative_path, "assets/logo.txt");
    assert_eq!(inspected.files[0].size, 4);
    assert_eq!(inspected.files[1].relative_path, "report.txt");
    assert_eq!(inspected.files[1].size, 6);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn skips_duplicate_upload_roots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "fineshell-upload-duplicates-{}-{unique}",
        std::process::id()
    ));
    let first = root.join("first");
    let second = root.join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("same.txt"), b"first").unwrap();
    fs::write(second.join("same.txt"), b"second").unwrap();

    let inspected = inspect_upload_paths(vec![
        first.join("same.txt").to_string_lossy().into_owned(),
        second.join("same.txt").to_string_lossy().into_owned(),
    ])
    .unwrap();

    assert_eq!(inspected.files.len(), 1);
    assert_eq!(inspected.files[0].relative_path, "same.txt");
    assert_eq!(inspected.skipped_paths, 1);
    fs::remove_dir_all(root).unwrap();
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
    let username = std::env::var("FINESHELL_LIVE_USERNAME").unwrap_or_else(|_| "root".to_string());
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
    let copied_path = format!("{directory}/copied.txt");
    let renamed_path = format!("{directory}/renamed.txt");
    let source_directory = format!("{directory}/source-dir");
    let source_nested_path = format!("{source_directory}/nested.txt");
    let copied_directory = format!("{directory}/copied-dir");
    let copied_nested_path = format!("{copied_directory}/nested.txt");
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

        let entries = super::list_directory(
            &session,
            &sftp,
            &directory,
            &mut RemoteIdentityCache::default(),
        )?;
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
        super::copy_remote_entry(&sftp, &source_path, &copied_path, false)?;
        let copied = super::read_remote_text_file(&sftp, &copied_path)?;
        if copied.content != edited_content {
            return Err("复制后的远程文件内容不一致".to_string());
        }
        if super::copy_remote_entry(&sftp, &source_path, &copied_path, false).is_ok() {
            return Err("复制到同名目标时没有阻止未确认的覆盖".to_string());
        }

        sftp.mkdir(Path::new(&source_directory), 0o750)
            .map_err(|error| format!("创建待复制目录失败：{error}"))?;
        let mut nested = sftp
            .create(Path::new(&source_nested_path))
            .map_err(|error| format!("创建待复制目录中的文件失败：{error}"))?;
        nested
            .write_all(content)
            .map_err(|error| format!("写入待复制目录中的文件失败：{error}"))?;
        drop(nested);
        super::copy_remote_entry(&sftp, &source_directory, &copied_directory, false)?;
        let copied_nested = super::read_remote_text_file(&sftp, &copied_nested_path)?;
        if copied_nested.content.as_bytes() != content {
            return Err("递归复制后的远程文件内容不一致".to_string());
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

        super::move_remote_entry(&sftp, &source_path, &renamed_path, false)?;
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
    let _ = sftp.unlink(Path::new(&copied_path));
    let _ = sftp.unlink(Path::new(&renamed_path));
    let _ = sftp.unlink(Path::new(&source_nested_path));
    let _ = sftp.unlink(Path::new(&copied_nested_path));
    let _ = sftp.rmdir(Path::new(&source_directory));
    let _ = sftp.rmdir(Path::new(&copied_directory));
    let _ = sftp.rmdir(Path::new(&directory));
    result
}
