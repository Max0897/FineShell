use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs::{self, File as LocalFile, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use ssh2::{FileStat, FileType, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter};

use crate::protocol::SFTP_TRANSFER_EVENT;
use crate::ssh::{connect_authenticated_session, JumpHostConfig, SshAuthConfig, SshAuthMethod};
use crate::transport::ProxyConfig;

const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const TRANSFER_CANCELLED_ERROR: &str = "传输已取消";
pub(crate) const REMOTE_TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const REMOTE_TEXT_CONFLICT_ERROR: &str = "远程文件已被其他程序修改";

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
    jump_host: Option<JumpHostConfig>,
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
    owner: Option<String>,
    group: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpListResult {
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpTextFile {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) size: u64,
    pub(crate) modified_at: Option<u64>,
    pub(crate) permissions: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AiSftpFileOperationKind {
    Create,
    Rename,
    Delete,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AiSftpFileOperationRequest {
    pub(crate) operation: AiSftpFileOperationKind,
    pub(crate) path: String,
    pub(crate) target_path: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) expected_content: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSftpFileOperationResult {
    pub(crate) file: Option<SftpTextFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalUploadFile {
    path: String,
    relative_path: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalUploadInspection {
    files: Vec<LocalUploadFile>,
    directories: Vec<String>,
    skipped_paths: usize,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteArchiveFormat {
    TarGz,
    Tar,
    Zip,
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
    EnsureUploadDirectories {
        base_path: String,
        relative_paths: Vec<String>,
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
    Copy {
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
    SetOwner {
        path: String,
        owner: Option<String>,
        group: Option<String>,
        reply: Sender<Result<(), String>>,
    },
    CreateArchive {
        source_paths: Vec<String>,
        target_path: String,
        format: RemoteArchiveFormat,
        overwrite: bool,
        reply: Sender<Result<(), String>>,
    },
    ExtractArchive {
        archive_path: String,
        target_directory: String,
        format: RemoteArchiveFormat,
        create_directory: bool,
        reply: Sender<Result<(), String>>,
    },
    ReadTextFile {
        path: String,
        reply: Sender<Result<SftpTextFile, String>>,
    },
    WriteTextFile {
        path: String,
        content: String,
        original_content: String,
        overwrite: bool,
        reply: Sender<Result<SftpTextFile, String>>,
    },
    ApplyAiFileOperation {
        request: AiSftpFileOperationRequest,
        reply: Sender<Result<AiSftpFileOperationResult, String>>,
    },
    Close,
}

#[derive(Clone)]
enum SftpHandle {
    Connecting(Arc<AtomicBool>),
    Connected {
        sender: Sender<SftpCommand>,
        auth: Box<SshAuthConfig>,
    },
}

#[derive(Default)]
struct TransferControl {
    cancelled: AtomicBool,
    paused: Mutex<bool>,
    wake: Condvar,
}

impl TransferControl {
    fn pause(&self) -> Result<(), String> {
        let mut paused = self
            .paused
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        *paused = true;
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        let mut paused = self
            .paused
            .lock()
            .map_err(|_| "传输任务状态不可用".to_string())?;
        *paused = false;
        self.wake.notify_all();
        Ok(())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut paused) = self.paused.lock() {
            *paused = false;
        }
        self.wake.notify_all();
    }
}

mod archive;
mod manager;
mod operations;
mod session;
mod text;
mod transfer;

use archive::*;
pub(crate) use manager::SftpSessionManager;
use operations::*;
use session::*;
use text::*;
use transfer::*;

mod commands;

pub(crate) use commands::*;

#[cfg(test)]
mod tests;
