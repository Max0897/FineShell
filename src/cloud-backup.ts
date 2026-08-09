import { isTauri } from "@tauri-apps/api/core";
import { diagnosticInvoke as invoke } from "./diagnostics";
import type { CredentialReferenceRecord } from "./credential-registry";

const STORAGE_KEY = "fineshell.cloud-backup.settings";

export type CloudBackupProtectionMode = "password" | "recoveryKey" | "none";

export interface CloudStorageConfig {
  profileId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
}

export interface CloudBackupSettings {
  storage: CloudStorageConfig;
  protectionMode: CloudBackupProtectionMode;
  includeCredentials: boolean;
  retentionCount: number;
}

export interface CloudBackupRepositoryStatus {
  exists: boolean;
  repositoryId?: string;
  createdAt?: string;
  protectionMode?: CloudBackupProtectionMode;
  unlocked: boolean;
  credentialConfigured: boolean;
}

export interface CloudBackupInitializeResult {
  repositoryId: string;
  protectionMode: CloudBackupProtectionMode;
  recoveryKey?: string;
}

export interface CloudBackupSnapshot {
  key: string;
  createdAt: string;
  size: number;
}

export interface CloudBackupDownloadResult {
  configuration: string;
  credentialCount: number;
  credentialReferences: CredentialReferenceRecord[];
  restoreToken?: string;
  createdAt: string;
  deviceName: string;
  appVersion: string;
}

export const DEFAULT_CLOUD_BACKUP_SETTINGS: CloudBackupSettings = {
  storage: {
    profileId: "default",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "FineShell",
  },
  protectionMode: "password",
  includeCredentials: false,
  retentionCount: 10,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sanitizeCloudBackupSettings(
  value: unknown,
): CloudBackupSettings {
  const source = record(value);
  const storage = record(source?.storage);
  const protectionMode = source?.protectionMode;
  return {
    storage: {
      profileId:
        typeof storage?.profileId === "string" && storage.profileId.trim()
          ? storage.profileId.trim().slice(0, 160)
          : "default",
      endpoint:
        typeof storage?.endpoint === "string"
          ? storage.endpoint.trim().slice(0, 2048)
          : "",
      region:
        typeof storage?.region === "string" && storage.region.trim()
          ? storage.region.trim().slice(0, 120)
          : "us-east-1",
      bucket:
        typeof storage?.bucket === "string"
          ? storage.bucket.trim().slice(0, 255)
          : "",
      prefix:
        typeof storage?.prefix === "string"
          ? storage.prefix.trim().slice(0, 512)
          : "FineShell",
    },
    protectionMode:
      protectionMode === "recoveryKey" || protectionMode === "none"
        ? protectionMode
        : "password",
    includeCredentials: source?.includeCredentials === true,
    retentionCount:
      typeof source?.retentionCount === "number" &&
      Number.isFinite(source.retentionCount)
        ? Math.min(100, Math.max(1, Math.round(source.retentionCount)))
        : 10,
  };
}

export function loadCloudBackupSettings() {
  try {
    return sanitizeCloudBackupSettings(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return { ...DEFAULT_CLOUD_BACKUP_SETTINGS };
  }
}

export function saveCloudBackupSettings(settings: CloudBackupSettings) {
  const sanitized = sanitizeCloudBackupSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
}

function requireDesktop() {
  if (!isTauri()) throw new Error("云备份仅支持桌面应用");
}

export async function storeCloudBackupCredentials(
  profileId: string,
  accessKeyId: string,
  secretAccessKey: string,
) {
  requireDesktop();
  await invoke("cloud_backup_store_s3_credentials", {
    profileId,
    accessKeyId,
    secretAccessKey,
  });
}

export async function cloudBackupCredentialStatus(profileId: string) {
  requireDesktop();
  return invoke<boolean>("cloud_backup_s3_credential_status", { profileId });
}

export async function testCloudBackupConnection(storage: CloudStorageConfig) {
  requireDesktop();
  await invoke("cloud_backup_test_connection", { storage });
}

export async function readCloudBackupRepository(storage: CloudStorageConfig) {
  requireDesktop();
  return invoke<CloudBackupRepositoryStatus>("cloud_backup_repository_status", {
    storage,
  });
}

export async function initializeCloudBackupRepository(
  storage: CloudStorageConfig,
  protectionMode: CloudBackupProtectionMode,
  password?: string,
) {
  requireDesktop();
  return invoke<CloudBackupInitializeResult>(
    "cloud_backup_initialize_repository",
    { storage, protectionMode, password },
  );
}

export async function unlockCloudBackupRepository(
  storage: CloudStorageConfig,
  secret: string,
) {
  requireDesktop();
  await invoke("cloud_backup_unlock_repository", { storage, secret });
}

export async function listCloudBackupSnapshots(storage: CloudStorageConfig) {
  requireDesktop();
  return invoke<CloudBackupSnapshot[]>("cloud_backup_list_snapshots", {
    storage,
  });
}

export async function createCloudBackupSnapshot(request: {
  storage: CloudStorageConfig;
  configuration: string;
  credentialReferences: CredentialReferenceRecord[];
  includeCredentials: boolean;
  deviceName: string;
  appVersion: string;
  retentionCount: number;
}) {
  requireDesktop();
  return invoke<CloudBackupSnapshot>("cloud_backup_create_snapshot", {
    request,
  });
}

export async function downloadCloudBackupSnapshot(
  storage: CloudStorageConfig,
  key: string,
) {
  requireDesktop();
  return invoke<CloudBackupDownloadResult>("cloud_backup_download_snapshot", {
    storage,
    key,
  });
}

export async function applyCloudBackupCredentials(restoreToken: string) {
  requireDesktop();
  return invoke<number>("cloud_backup_apply_credentials", { restoreToken });
}

export async function discardCloudBackupRestore(restoreToken: string) {
  requireDesktop();
  await invoke("cloud_backup_discard_restore", { restoreToken });
}

export async function deleteCloudBackupSnapshot(
  storage: CloudStorageConfig,
  key: string,
) {
  requireDesktop();
  await invoke("cloud_backup_delete_snapshot", { storage, key });
}
