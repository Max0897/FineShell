use serde::{Deserialize, Serialize};

pub(crate) const REPOSITORY_FORMAT: &str = "fineshell-cloud-backup-repository";
pub(crate) const SNAPSHOT_FORMAT: &str = "fineshell-cloud-backup-snapshot";
pub(crate) const FORMAT_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudStorageConfig {
    pub profile_id: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProtectionMode {
    Password,
    RecoveryKey,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WrappedMasterKey {
    pub algorithm: String,
    pub kdf: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryDescriptor {
    pub format: String,
    pub version: u16,
    pub repository_id: String,
    pub created_at: String,
    pub protection_mode: ProtectionMode,
    pub wrapped_master_key: Option<WrappedMasterKey>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryStatus {
    pub exists: bool,
    pub repository_id: Option<String>,
    pub created_at: Option<String>,
    pub protection_mode: Option<ProtectionMode>,
    pub unlocked: bool,
    pub credential_configured: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryInitializeResult {
    pub repository_id: String,
    pub protection_mode: ProtectionMode,
    pub recovery_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupCredentialReference {
    pub kind: String,
    pub owner_id: String,
    pub label: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCredential {
    pub kind: String,
    pub owner_id: String,
    pub label: String,
    pub updated_at: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotPayload {
    pub configuration: String,
    #[serde(default)]
    pub credentials: Vec<StoredCredential>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotEnvelope {
    pub format: String,
    pub version: u16,
    pub repository_id: String,
    pub created_at: String,
    pub device_name: String,
    pub app_version: String,
    pub encrypted: bool,
    pub nonce: Option<String>,
    pub payload: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotMetadata {
    pub key: String,
    pub created_at: String,
    pub size: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotDownloadResult {
    pub configuration: String,
    pub credential_count: usize,
    pub credential_references: Vec<BackupCredentialReference>,
    pub restore_token: Option<String>,
    pub created_at: String,
    pub device_name: String,
    pub app_version: String,
}
