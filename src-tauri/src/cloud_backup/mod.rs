mod crypto;
mod types;

use std::{collections::HashMap, sync::Mutex};

use aws_credential_types::Credentials;
use aws_sdk_s3::{config::Region, primitives::ByteStream, Client};
use aws_smithy_runtime_api::client::{orchestrator::HttpResponse, result::SdkError};
use aws_smithy_types::error::{display::DisplayErrorContext, metadata::ProvideErrorMetadata};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use self::{
    crypto::{
        decrypt_payload, encrypt_payload, generate_recovery_key, random_master_key,
        unwrap_master_key, wrap_master_key,
    },
    types::{
        BackupCredentialReference, CloudStorageConfig, ProtectionMode, RepositoryDescriptor,
        RepositoryInitializeResult, RepositoryStatus, SnapshotDownloadResult, SnapshotEnvelope,
        SnapshotMetadata, SnapshotPayload, StoredCredential, FORMAT_VERSION, REPOSITORY_FORMAT,
        SNAPSHOT_FORMAT,
    },
};

const S3_CREDENTIAL_SERVICE: &str = "com.fineshell.app.cloud-backup-s3";
const MASTER_KEY_SERVICE: &str = "com.fineshell.app.cloud-backup-key";
const REPOSITORY_FILE: &str = "repository.json";

#[derive(Default)]
pub(crate) struct CloudBackupManager {
    pending_credentials: Mutex<HashMap<String, Vec<StoredCredential>>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3CredentialValue {
    access_key_id: String,
    secret_access_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSnapshotRequest {
    storage: CloudStorageConfig,
    configuration: String,
    #[serde(default)]
    credential_references: Vec<BackupCredentialReference>,
    #[serde(default)]
    include_credentials: bool,
    device_name: String,
    app_version: String,
    retention_count: Option<usize>,
}

fn now_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| format!("生成备份时间失败：{error}"))
}

fn random_id(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn validate_storage(config: &CloudStorageConfig) -> Result<(), String> {
    if config.profile_id.trim().is_empty() {
        return Err("S3 配置标识不能为空".to_string());
    }
    if config.region.trim().is_empty() {
        return Err("S3 区域不能为空".to_string());
    }
    let bucket = config.bucket.trim();
    if bucket.is_empty() {
        return Err("S3 Bucket 不能为空".to_string());
    }
    if !(3..=63).contains(&bucket.len()) {
        return Err("S3 Bucket 长度必须为 3 到 63 个字符".to_string());
    }
    if !bucket.bytes().all(|value| {
        value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, b'.' | b'-')
    }) {
        return Err("S3 Bucket 只能使用小写字母、数字、点和连字符".to_string());
    }
    if !bucket
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        || !bucket
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || bucket.contains("..")
    {
        return Err("S3 Bucket 必须以字母或数字开头和结尾，且不能包含连续的点".to_string());
    }
    let endpoint = config.endpoint.trim();
    if endpoint.is_empty() {
        return Err("S3 Endpoint 不能为空".to_string());
    }
    if !endpoint.starts_with("https://") && !endpoint.starts_with("http://") {
        return Err("S3 Endpoint 必须以 http:// 或 https:// 开头".to_string());
    }
    Ok(())
}

fn format_s3_error<E>(action: &str, error: &SdkError<E, HttpResponse>) -> String
where
    E: std::error::Error + ProvideErrorMetadata + 'static,
{
    let mut details = Vec::new();
    if let Some(response) = error.raw_response() {
        details.push(format!("HTTP {}", response.status().as_u16()));
    }
    if let Some(service_error) = error.as_service_error() {
        if let Some(code) = service_error
            .code()
            .filter(|value| !value.trim().is_empty())
        {
            details.push(code.to_string());
        }
        if let Some(message) = service_error
            .message()
            .filter(|value| !value.trim().is_empty())
        {
            details.push(message.to_string());
        }
    }
    if details.is_empty() {
        details.push(format!("{}", DisplayErrorContext(error)));
    }
    format!("{action}：{}", details.join(" · "))
}

fn prefix(config: &CloudStorageConfig) -> String {
    config.prefix.trim().trim_matches('/').to_string()
}

fn object_key(config: &CloudStorageConfig, suffix: &str) -> String {
    let prefix = prefix(config);
    if prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{prefix}/{suffix}")
    }
}

fn s3_credential_entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(S3_CREDENTIAL_SERVICE, profile_id)
        .map_err(|error| format!("无法访问 S3 系统凭据：{error}"))
}

fn master_key_entry(repository_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(MASTER_KEY_SERVICE, repository_id)
        .map_err(|error| format!("无法访问备份主密钥：{error}"))
}

fn load_s3_credentials(profile_id: &str) -> Result<S3CredentialValue, String> {
    let value = s3_credential_entry(profile_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => "尚未保存 S3 访问凭据".to_string(),
            _ => format!("读取 S3 访问凭据失败：{error}"),
        })?;
    serde_json::from_str(&value).map_err(|_| "保存的 S3 访问凭据已损坏".to_string())
}

fn s3_credential_exists(profile_id: &str) -> Result<bool, String> {
    match s3_credential_entry(profile_id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("检查 S3 访问凭据失败：{error}")),
    }
}

fn store_master_key(repository_id: &str, master_key: &[u8; 32]) -> Result<(), String> {
    master_key_entry(repository_id)?
        .set_password(&STANDARD.encode(master_key))
        .map_err(|error| format!("保存备份主密钥失败：{error}"))
}

fn load_master_key(repository_id: &str) -> Result<Option<[u8; 32]>, String> {
    let value = match master_key_entry(repository_id)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("读取备份主密钥失败：{error}")),
    };
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| "保存的备份主密钥已损坏".to_string())?;
    decoded
        .try_into()
        .map(Some)
        .map_err(|_| "保存的备份主密钥长度无效".to_string())
}

fn s3_client(config: &CloudStorageConfig) -> Result<Client, String> {
    validate_storage(config)?;
    let credential = load_s3_credentials(&config.profile_id)?;
    let provider = Credentials::new(
        credential.access_key_id,
        credential.secret_access_key,
        None,
        None,
        "FineShell",
    );
    let mut builder = aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .credentials_provider(provider)
        .region(Region::new(config.region.trim().to_string()))
        .force_path_style(true);
    builder = builder.endpoint_url(config.endpoint.trim());
    Ok(Client::from_conf(builder.build()))
}

async fn object_exists(
    client: &Client,
    config: &CloudStorageConfig,
    key: &str,
) -> Result<bool, String> {
    let result = client
        .list_objects_v2()
        .bucket(config.bucket.trim())
        .prefix(key)
        .max_keys(1)
        .send()
        .await
        .map_err(|error| format_s3_error("读取 S3 对象列表失败", &error))?;
    Ok(result
        .contents()
        .iter()
        .any(|object| object.key() == Some(key)))
}

async fn get_object(
    client: &Client,
    config: &CloudStorageConfig,
    key: &str,
) -> Result<Vec<u8>, String> {
    let result = client
        .get_object()
        .bucket(config.bucket.trim())
        .key(key)
        .send()
        .await
        .map_err(|error| format_s3_error("下载 S3 对象失败", &error))?;
    result
        .body
        .collect()
        .await
        .map(|body| body.into_bytes().to_vec())
        .map_err(|error| format!("读取 S3 对象内容失败：{error}"))
}

async fn put_object(
    client: &Client,
    config: &CloudStorageConfig,
    key: &str,
    content: Vec<u8>,
) -> Result<(), String> {
    client
        .put_object()
        .bucket(config.bucket.trim())
        .key(key)
        .content_type("application/json")
        .body(ByteStream::from(content))
        .send()
        .await
        .map(|_| ())
        .map_err(|error| format_s3_error("上传 S3 对象失败", &error))
}

async fn read_descriptor(
    client: &Client,
    config: &CloudStorageConfig,
) -> Result<Option<RepositoryDescriptor>, String> {
    let key = object_key(config, REPOSITORY_FILE);
    if !object_exists(client, config, &key).await? {
        return Ok(None);
    }
    let bytes = get_object(client, config, &key).await?;
    let descriptor: RepositoryDescriptor =
        serde_json::from_slice(&bytes).map_err(|_| "云端仓库描述文件已损坏".to_string())?;
    if descriptor.format != REPOSITORY_FORMAT || descriptor.version > FORMAT_VERSION {
        return Err("云端备份仓库版本不受支持".to_string());
    }
    Ok(Some(descriptor))
}

fn collect_credentials(
    references: Vec<BackupCredentialReference>,
) -> Result<Vec<StoredCredential>, String> {
    let mut credentials = Vec::new();
    for reference in references {
        if let Some(value) =
            crate::credentials::read_backup_credential(&reference.kind, &reference.owner_id)?
        {
            credentials.push(StoredCredential {
                kind: reference.kind,
                owner_id: reference.owner_id,
                label: reference.label,
                updated_at: reference.updated_at,
                value,
            });
        }
    }
    Ok(credentials)
}

fn structured<T>(
    operation: &'static str,
    result: Result<T, String>,
) -> crate::protocol::CommandResult<T> {
    result.map_err(|error| crate::protocol::CommandError::from_message(operation, error))
}

#[tauri::command]
pub(crate) fn cloud_backup_store_s3_credentials(
    profile_id: String,
    access_key_id: String,
    secret_access_key: String,
) -> crate::protocol::CommandResult<()> {
    structured(
        "cloud_backup_store_s3_credentials",
        (|| {
            if profile_id.trim().is_empty()
                || access_key_id.trim().is_empty()
                || secret_access_key.is_empty()
            {
                return Err("S3 配置标识、Access Key 和 Secret Key 不能为空".to_string());
            }
            let value = S3CredentialValue {
                access_key_id: access_key_id.trim().to_string(),
                secret_access_key,
            };
            let serialized = serde_json::to_string(&value)
                .map_err(|error| format!("序列化 S3 访问凭据失败：{error}"))?;
            s3_credential_entry(profile_id.trim())?
                .set_password(&serialized)
                .map_err(|error| format!("保存 S3 访问凭据失败：{error}"))
        })(),
    )
}

#[tauri::command]
pub(crate) fn cloud_backup_delete_s3_credentials(
    profile_id: String,
) -> crate::protocol::CommandResult<()> {
    structured(
        "cloud_backup_delete_s3_credentials",
        (|| match s3_credential_entry(profile_id.trim())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除 S3 访问凭据失败：{error}")),
        })(),
    )
}

#[tauri::command]
pub(crate) fn cloud_backup_s3_credential_status(
    profile_id: String,
) -> crate::protocol::CommandResult<bool> {
    structured(
        "cloud_backup_s3_credential_status",
        s3_credential_exists(profile_id.trim()),
    )
}

#[tauri::command]
pub(crate) async fn cloud_backup_test_connection(
    storage: CloudStorageConfig,
) -> crate::protocol::CommandResult<()> {
    let result = async {
        let client = s3_client(&storage)?;
        let key = object_key(&storage, &format!(".fineshell-write-test-{}", random_id(8)));
        put_object(&client, &storage, &key, b"FineShell".to_vec()).await?;
        client
            .delete_object()
            .bucket(storage.bucket.trim())
            .key(&key)
            .send()
            .await
            .map_err(|error| format_s3_error("清理 S3 测试对象失败", &error))?;
        Ok(())
    }
    .await;
    structured("cloud_backup_test_connection", result)
}

#[tauri::command]
pub(crate) async fn cloud_backup_repository_status(
    storage: CloudStorageConfig,
) -> crate::protocol::CommandResult<RepositoryStatus> {
    let result = async {
        let credential_configured = s3_credential_exists(&storage.profile_id)?;
        let client = s3_client(&storage)?;
        let Some(descriptor) = read_descriptor(&client, &storage).await? else {
            return Ok(RepositoryStatus {
                exists: false,
                repository_id: None,
                created_at: None,
                protection_mode: None,
                unlocked: false,
                credential_configured,
            });
        };
        let unlocked = descriptor.protection_mode == ProtectionMode::None
            || load_master_key(&descriptor.repository_id)?.is_some();
        Ok(RepositoryStatus {
            exists: true,
            repository_id: Some(descriptor.repository_id),
            created_at: Some(descriptor.created_at),
            protection_mode: Some(descriptor.protection_mode),
            unlocked,
            credential_configured,
        })
    }
    .await;
    structured("cloud_backup_repository_status", result)
}

#[tauri::command]
pub(crate) async fn cloud_backup_initialize_repository(
    storage: CloudStorageConfig,
    protection_mode: ProtectionMode,
    password: Option<String>,
) -> crate::protocol::CommandResult<RepositoryInitializeResult> {
    let result = async {
        let client = s3_client(&storage)?;
        if read_descriptor(&client, &storage).await?.is_some() {
            return Err("该路径已经存在 FineShell 云备份仓库".to_string());
        }
        let repository_id = format!("repo-{}", random_id(18));
        let created_at = now_rfc3339()?;
        let (wrapped_master_key, recovery_key) = match protection_mode {
            ProtectionMode::None => (None, None),
            ProtectionMode::Password => {
                let master_key = random_master_key();
                let secret = password.as_deref().unwrap_or_default();
                let wrapped = wrap_master_key(&master_key, secret, false)?;
                store_master_key(&repository_id, &master_key)?;
                (Some(wrapped), None)
            }
            ProtectionMode::RecoveryKey => {
                let master_key = random_master_key();
                let recovery_key = generate_recovery_key();
                let wrapped = wrap_master_key(&master_key, &recovery_key, true)?;
                store_master_key(&repository_id, &master_key)?;
                (Some(wrapped), Some(recovery_key))
            }
        };
        let descriptor = RepositoryDescriptor {
            format: REPOSITORY_FORMAT.to_string(),
            version: FORMAT_VERSION,
            repository_id: repository_id.clone(),
            created_at,
            protection_mode,
            wrapped_master_key,
        };
        let content = serde_json::to_vec_pretty(&descriptor)
            .map_err(|error| format!("生成云端仓库描述失败：{error}"))?;
        put_object(
            &client,
            &storage,
            &object_key(&storage, REPOSITORY_FILE),
            content,
        )
        .await?;
        Ok(RepositoryInitializeResult {
            repository_id,
            protection_mode,
            recovery_key,
        })
    }
    .await;
    structured("cloud_backup_initialize_repository", result)
}

#[tauri::command]
pub(crate) async fn cloud_backup_unlock_repository(
    storage: CloudStorageConfig,
    secret: String,
) -> crate::protocol::CommandResult<()> {
    let result = async {
        let client = s3_client(&storage)?;
        let descriptor = read_descriptor(&client, &storage)
            .await?
            .ok_or_else(|| "云端路径中没有 FineShell 备份仓库".to_string())?;
        let wrapped = descriptor
            .wrapped_master_key
            .as_ref()
            .ok_or_else(|| "该仓库未启用加密，无需解锁".to_string())?;
        let master_key = unwrap_master_key(
            wrapped,
            &secret,
            descriptor.protection_mode == ProtectionMode::RecoveryKey,
        )?;
        store_master_key(&descriptor.repository_id, &master_key)
    }
    .await;
    structured("cloud_backup_unlock_repository", result)
}

async fn list_snapshots_inner(
    client: &Client,
    storage: &CloudStorageConfig,
) -> Result<Vec<SnapshotMetadata>, String> {
    let snapshot_prefix = object_key(storage, "snapshots/");
    let result = client
        .list_objects_v2()
        .bucket(storage.bucket.trim())
        .prefix(&snapshot_prefix)
        .send()
        .await
        .map_err(|error| format_s3_error("读取云备份列表失败", &error))?;
    let mut snapshots = result
        .contents()
        .iter()
        .filter_map(|object| {
            let key = object.key()?.to_string();
            key.ends_with(".fsbackup").then(|| SnapshotMetadata {
                key,
                created_at: object
                    .last_modified()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
                size: object.size().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| right.key.cmp(&left.key));
    Ok(snapshots)
}

#[tauri::command]
pub(crate) async fn cloud_backup_list_snapshots(
    storage: CloudStorageConfig,
) -> crate::protocol::CommandResult<Vec<SnapshotMetadata>> {
    let result = async {
        let client = s3_client(&storage)?;
        read_descriptor(&client, &storage)
            .await?
            .ok_or_else(|| "云端路径中没有 FineShell 备份仓库".to_string())?;
        list_snapshots_inner(&client, &storage).await
    }
    .await;
    structured("cloud_backup_list_snapshots", result)
}

#[tauri::command]
pub(crate) async fn cloud_backup_create_snapshot(
    request: CreateSnapshotRequest,
) -> crate::protocol::CommandResult<SnapshotMetadata> {
    let result = async {
        if request.configuration.len() > 32 * 1024 * 1024 {
            return Err("配置备份超过 32 MB，已拒绝上传".to_string());
        }
        let client = s3_client(&request.storage)?;
        let descriptor = read_descriptor(&client, &request.storage)
            .await?
            .ok_or_else(|| "请先初始化云备份仓库".to_string())?;
        if request.include_credentials && descriptor.protection_mode == ProtectionMode::None {
            return Err("无加密模式不能备份主机密码和私钥口令".to_string());
        }
        let credentials = if request.include_credentials {
            collect_credentials(request.credential_references)?
        } else {
            Vec::new()
        };
        let payload = SnapshotPayload {
            configuration: request.configuration,
            credentials,
        };
        let payload_bytes =
            serde_json::to_vec(&payload).map_err(|error| format!("生成备份内容失败：{error}"))?;
        let created_at = now_rfc3339()?;
        let (encrypted, nonce, payload) = match descriptor.protection_mode {
            ProtectionMode::None => (false, None, STANDARD.encode(payload_bytes)),
            ProtectionMode::Password | ProtectionMode::RecoveryKey => {
                let master_key = load_master_key(&descriptor.repository_id)?
                    .ok_or_else(|| "云备份仓库尚未解锁".to_string())?;
                let (nonce, ciphertext) = encrypt_payload(&master_key, &payload_bytes)?;
                (true, Some(nonce), ciphertext)
            }
        };
        let envelope = SnapshotEnvelope {
            format: SNAPSHOT_FORMAT.to_string(),
            version: FORMAT_VERSION,
            repository_id: descriptor.repository_id,
            created_at: created_at.clone(),
            device_name: request.device_name.trim().chars().take(120).collect(),
            app_version: request.app_version.trim().chars().take(40).collect(),
            encrypted,
            nonce,
            payload,
        };
        let content =
            serde_json::to_vec(&envelope).map_err(|error| format!("生成备份信封失败：{error}"))?;
        let key = object_key(
            &request.storage,
            &format!(
                "snapshots/{}-{}.fsbackup",
                OffsetDateTime::now_utc().unix_timestamp_nanos(),
                random_id(8)
            ),
        );
        let size = content.len() as i64;
        put_object(&client, &request.storage, &key, content).await?;

        if let Some(retention_count) = request.retention_count.filter(|count| *count > 0) {
            let snapshots = list_snapshots_inner(&client, &request.storage).await?;
            for snapshot in snapshots.into_iter().skip(retention_count.clamp(1, 100)) {
                client
                    .delete_object()
                    .bucket(request.storage.bucket.trim())
                    .key(snapshot.key)
                    .send()
                    .await
                    .map_err(|error| format_s3_error("清理过期云备份失败", &error))?;
            }
        }

        Ok(SnapshotMetadata {
            key,
            created_at,
            size,
        })
    }
    .await;
    structured("cloud_backup_create_snapshot", result)
}

#[tauri::command]
pub(crate) async fn cloud_backup_download_snapshot(
    manager: tauri::State<'_, CloudBackupManager>,
    storage: CloudStorageConfig,
    key: String,
) -> crate::protocol::CommandResult<SnapshotDownloadResult> {
    let result = async {
        let expected_prefix = object_key(&storage, "snapshots/");
        if !key.starts_with(&expected_prefix) || !key.ends_with(".fsbackup") {
            return Err("备份对象路径无效".to_string());
        }
        let client = s3_client(&storage)?;
        let descriptor = read_descriptor(&client, &storage)
            .await?
            .ok_or_else(|| "云端路径中没有 FineShell 备份仓库".to_string())?;
        let bytes = get_object(&client, &storage, &key).await?;
        let envelope: SnapshotEnvelope =
            serde_json::from_slice(&bytes).map_err(|_| "云备份文件已损坏".to_string())?;
        if envelope.format != SNAPSHOT_FORMAT
            || envelope.version > FORMAT_VERSION
            || envelope.repository_id != descriptor.repository_id
        {
            return Err("云备份文件与当前仓库不匹配".to_string());
        }
        let payload_bytes = if envelope.encrypted {
            let master_key = load_master_key(&descriptor.repository_id)?
                .ok_or_else(|| "云备份仓库尚未解锁".to_string())?;
            decrypt_payload(
                &master_key,
                envelope.nonce.as_deref().unwrap_or_default(),
                &envelope.payload,
            )?
        } else {
            STANDARD
                .decode(&envelope.payload)
                .map_err(|_| "云备份内容已损坏".to_string())?
        };
        let payload: SnapshotPayload =
            serde_json::from_slice(&payload_bytes).map_err(|_| "云备份内容格式无效".to_string())?;
        let credential_references = payload
            .credentials
            .iter()
            .map(|credential| BackupCredentialReference {
                kind: credential.kind.clone(),
                owner_id: credential.owner_id.clone(),
                label: credential.label.clone(),
                updated_at: credential.updated_at.clone(),
            })
            .collect::<Vec<_>>();
        let restore_token = if payload.credentials.is_empty() {
            None
        } else {
            let token = random_id(24);
            manager
                .pending_credentials
                .lock()
                .map_err(|_| "凭据恢复暂存区不可用".to_string())?
                .insert(token.clone(), payload.credentials);
            Some(token)
        };
        Ok(SnapshotDownloadResult {
            configuration: payload.configuration,
            credential_count: credential_references.len(),
            credential_references,
            restore_token,
            created_at: envelope.created_at,
            device_name: envelope.device_name,
            app_version: envelope.app_version,
        })
    }
    .await;
    structured("cloud_backup_download_snapshot", result)
}

#[tauri::command]
pub(crate) fn cloud_backup_apply_credentials(
    manager: tauri::State<'_, CloudBackupManager>,
    restore_token: String,
) -> crate::protocol::CommandResult<usize> {
    structured(
        "cloud_backup_apply_credentials",
        (|| {
            let credentials = manager
                .pending_credentials
                .lock()
                .map_err(|_| "凭据恢复暂存区不可用".to_string())?
                .get(&restore_token)
                .cloned()
                .ok_or_else(|| "凭据恢复请求已失效，请重新下载备份".to_string())?;

            let previous_values = credentials
                .iter()
                .map(|credential| {
                    crate::credentials::read_backup_credential(
                        &credential.kind,
                        &credential.owner_id,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;

            for (index, credential) in credentials.iter().enumerate() {
                if let Err(error) = crate::credentials::restore_backup_credential(
                    &credential.kind,
                    &credential.owner_id,
                    &credential.value,
                ) {
                    let mut rollback_errors = Vec::new();
                    for rollback_index in (0..index).rev() {
                        let rollback_credential = &credentials[rollback_index];
                        let rollback_result = match &previous_values[rollback_index] {
                            Some(previous) => crate::credentials::restore_backup_credential(
                                &rollback_credential.kind,
                                &rollback_credential.owner_id,
                                previous,
                            ),
                            None => crate::credentials::delete_backup_credential(
                                &rollback_credential.kind,
                                &rollback_credential.owner_id,
                            ),
                        };
                        if let Err(rollback_error) = rollback_result {
                            rollback_errors.push(rollback_error);
                        }
                    }
                    return Err(if rollback_errors.is_empty() {
                        error
                    } else {
                        format!("{error}；回滚部分凭据失败：{}", rollback_errors.join("；"))
                    });
                }
            }

            manager
                .pending_credentials
                .lock()
                .map_err(|_| "凭据恢复暂存区不可用".to_string())?
                .remove(&restore_token);
            Ok(credentials.len())
        })(),
    )
}

#[tauri::command]
pub(crate) fn cloud_backup_discard_restore(
    manager: tauri::State<'_, CloudBackupManager>,
    restore_token: String,
) -> crate::protocol::CommandResult<()> {
    structured(
        "cloud_backup_discard_restore",
        manager
            .pending_credentials
            .lock()
            .map_err(|_| "凭据恢复暂存区不可用".to_string())
            .map(|mut pending| {
                pending.remove(&restore_token);
            }),
    )
}

#[tauri::command]
pub(crate) async fn cloud_backup_delete_snapshot(
    storage: CloudStorageConfig,
    key: String,
) -> crate::protocol::CommandResult<()> {
    let result = async {
        let expected_prefix = object_key(&storage, "snapshots/");
        if !key.starts_with(&expected_prefix) || !key.ends_with(".fsbackup") {
            return Err("备份对象路径无效".to_string());
        }
        let client = s3_client(&storage)?;
        client
            .delete_object()
            .bucket(storage.bucket.trim())
            .key(key)
            .send()
            .await
            .map(|_| ())
            .map_err(|error| format_s3_error("删除云备份失败", &error))
    }
    .await;
    structured("cloud_backup_delete_snapshot", result)
}

#[cfg(test)]
mod tests {
    use super::{object_key, prefix, validate_storage, CloudStorageConfig};

    fn storage() -> CloudStorageConfig {
        CloudStorageConfig {
            profile_id: "default".to_string(),
            endpoint: "https://s3.example.com".to_string(),
            region: "us-east-1".to_string(),
            bucket: "backup".to_string(),
            prefix: "/FineShell/device/".to_string(),
        }
    }

    #[test]
    fn normalizes_repository_object_prefix() {
        let storage = storage();
        assert_eq!(prefix(&storage), "FineShell/device");
        assert_eq!(
            object_key(&storage, "repository.json"),
            "FineShell/device/repository.json"
        );
    }

    #[test]
    fn validates_endpoint_and_bucket() {
        assert!(validate_storage(&storage()).is_ok());
        let mut invalid = storage();
        invalid.endpoint = "s3.example.com".to_string();
        assert!(validate_storage(&invalid).is_err());
        invalid.endpoint = String::new();
        assert_eq!(
            validate_storage(&invalid),
            Err("S3 Endpoint 不能为空".to_string())
        );
        invalid.endpoint = "https://s3.example.com".to_string();
        invalid.bucket = "nested/bucket".to_string();
        assert!(validate_storage(&invalid).is_err());
        invalid.bucket = "Fineshell-backup".to_string();
        assert_eq!(
            validate_storage(&invalid),
            Err("S3 Bucket 只能使用小写字母、数字、点和连字符".to_string())
        );
    }
}
