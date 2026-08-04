import { withHostDefaults } from "./host-storage";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "./app-settings";
import type {
  ConnectionHistoryRecord,
  DynamicPortForwardRule,
  HostRecord,
  HostSortMode,
  KnownHostRecord,
  LocalPortForwardRule,
  ProxyRecord,
  QuickCommandRecord,
  RemotePortForwardRule,
  SftpLocationRecord,
  SshKeyRecord,
  TerminalCommandHistoryRecord,
} from "./models";
import {
  deriveKnownHostRecords,
  knownHostRecordId,
  knownHostTargetKey,
  normalizeHostFingerprint,
  upsertKnownHostRecord,
} from "./known-hosts";
import { normalizeRemoteDirectoryPath } from "./sftp-utils";
import {
  getSshKeySource,
  managedSshKeyReference,
} from "./ssh-keys";
import { applyConnectionHistoryPolicy } from "./connection-history";
import {
  applyTerminalCommandHistoryPolicy,
  sanitizeTerminalCommandHistoryRecord,
} from "./terminal-command-history";
import {
  sanitizeCredentialReference,
  type CredentialReferenceRecord,
} from "./credential-registry";

const DATABASE_NAME = "fineshell.config";
const DATABASE_VERSION = 1;
const CONFIGURATION_STORE = "configuration";
const CONFIGURATION_ID = "primary";
const HOSTS_STORAGE_KEY = "fineshell.hosts";
const HISTORY_STORAGE_KEY = "fineshell.connection-history";

export const CONFIGURATION_SCHEMA_VERSION = 18;
export const CONFIGURATION_EXPORT_VERSION = 15;
export const MAX_CONFIGURATION_BACKUPS = 10;
export const TRASH_RETENTION_DAYS = 30;
export const MAX_SFTP_BOOKMARKS = 20;
export const MAX_SFTP_PATH_HISTORY = 30;

export interface ConfigurationBackup {
  id: string;
  createdAt: string;
  reason: string;
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  quickCommands: QuickCommandRecord[];
  hostSort: HostSortMode;
  sftpLocations: SftpLocationRecord[];
  knownHosts?: KnownHostRecord[];
  settings?: AppSettings;
}

export interface DeletedHostRecord {
  id: string;
  host: HostRecord;
  deletedAt: string;
  expiresAt: string;
}

export interface FineShellConfiguration {
  id: typeof CONFIGURATION_ID;
  schemaVersion: typeof CONFIGURATION_SCHEMA_VERSION;
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  quickCommands: QuickCommandRecord[];
  hostSort: HostSortMode;
  sftpLocations: SftpLocationRecord[];
  knownHosts: KnownHostRecord[];
  terminalCommandHistory: TerminalCommandHistoryRecord[];
  settings: AppSettings;
  credentialReferences: CredentialReferenceRecord[];
  backups: ConfigurationBackup[];
  trash: DeletedHostRecord[];
  updatedAt: string;
}

export interface FineShellConfigurationExport {
  format: "fineshell-config";
  schemaVersion: typeof CONFIGURATION_EXPORT_VERSION;
  exportedAt: string;
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  quickCommands: QuickCommandRecord[];
  hostSort: HostSortMode;
  sftpLocations: SftpLocationRecord[];
  knownHosts: KnownHostRecord[];
  settings: AppSettings;
}

type UnknownRecord = Record<string, unknown>;

let databasePromise: Promise<IDBDatabase> | undefined;
let initializationPromise: Promise<void> | undefined;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeHostSortMode(value: unknown): HostSortMode {
  return value === "nameAsc" ||
    value === "nameDesc" ||
    value === "addressAsc" ||
    value === "recentDesc"
    ? value
    : "manual";
}

function sanitizeProxy(value: unknown): ProxyRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const address = stringValue(value.address);
  if (!id || !name || !address) return undefined;

  return {
    id,
    name: name.trim(),
    type: value.type === "http" ? "http" : "socks5",
    address: address.trim(),
    port: numberValue(
      value.port,
      value.type === "http" ? 8080 : 1080,
      1,
      65_535,
    ),
    username: stringValue(value.username)?.trim(),
  };
}

function sanitizeSshKey(value: unknown): SshKeyRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const privateKeyPath = stringValue(value.privateKeyPath);
  if (!id || !name || !privateKeyPath) return undefined;

  const normalizedId = id.trim();
  const normalizedName = name.trim();
  const normalizedPath = privateKeyPath.trim();
  if (!normalizedId || !normalizedName || !normalizedPath) return undefined;
  const source = getSshKeySource({
    privateKeyPath: normalizedPath,
    source: value.source === "managed" ? "managed" : undefined,
  });
  if (
    source === "managed" &&
    (normalizedPath !== managedSshKeyReference(normalizedId) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(normalizedId))
  ) {
    return undefined;
  }

  return {
    id: normalizedId,
    name: normalizedName,
    privateKeyPath: normalizedPath,
    ...(source === "managed" ? { source } : {}),
  };
}

export function sanitizeQuickCommand(
  value: unknown,
): QuickCommandRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const command = stringValue(value.command);
  if (!id || !name || !command) return undefined;

  return {
    id: id.slice(0, 160),
    name: name.trim().slice(0, 80),
    command: command.trim().slice(0, 4000),
    group: stringValue(value.group)?.trim().slice(0, 60),
    description: stringValue(value.description)?.trim().slice(0, 160),
  };
}

function sanitizeRemotePaths(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    const path =
      typeof item === "string" ? normalizeRemoteDirectoryPath(item) : null;
    if (!path || paths.includes(path)) continue;
    paths.push(path);
    if (paths.length >= limit) break;
  }
  return paths;
}

export function sanitizeSftpLocation(
  value: unknown,
): SftpLocationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const hostId = stringValue(value.hostId);
  if (!hostId) return undefined;
  return {
    hostId,
    bookmarks: sanitizeRemotePaths(value.bookmarks, MAX_SFTP_BOOKMARKS),
    history: sanitizeRemotePaths(value.history, MAX_SFTP_PATH_HISTORY),
  };
}

function sanitizeLocalPortForward(
  value: unknown,
): LocalPortForwardRule | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const bindAddress = stringValue(value.bindAddress);
  const targetAddress = stringValue(value.targetAddress);
  if (!id || !name || !bindAddress || !targetAddress) return undefined;

  return {
    id,
    name: name.trim(),
    bindAddress: bindAddress.trim(),
    bindPort: numberValue(value.bindPort, 8080, 1, 65_535),
    targetAddress: targetAddress.trim(),
    targetPort: numberValue(value.targetPort, 80, 1, 65_535),
    enabled: optionalBoolean(value.enabled) ?? true,
  };
}

function sanitizeRemotePortForward(
  value: unknown,
): RemotePortForwardRule | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const bindAddress = stringValue(value.bindAddress);
  const targetAddress = stringValue(value.targetAddress);
  if (!id || !name || !bindAddress || !targetAddress) return undefined;

  return {
    id,
    name: name.trim(),
    bindAddress: bindAddress.trim(),
    bindPort: numberValue(value.bindPort, 8080, 1, 65_535),
    targetAddress: targetAddress.trim(),
    targetPort: numberValue(value.targetPort, 80, 1, 65_535),
    enabled: optionalBoolean(value.enabled) ?? true,
  };
}

function sanitizeDynamicPortForward(
  value: unknown,
): DynamicPortForwardRule | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const bindAddress = stringValue(value.bindAddress);
  if (!id || !name || !bindAddress) return undefined;

  return {
    id,
    name: name.trim(),
    bindAddress: bindAddress.trim(),
    bindPort: numberValue(value.bindPort, 1080, 1, 65_535),
    enabled: optionalBoolean(value.enabled) ?? true,
  };
}

function sanitizeHost(value: unknown): HostRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const address = stringValue(value.address);
  const username = stringValue(value.username);
  if (!id || !name || !address || !username) return undefined;
  const authMethod =
    value.authMethod === "privateKey" || value.authMethod === "agent"
      ? value.authMethod
      : "password";
  const sshKeyId =
    authMethod === "privateKey" ? stringValue(value.sshKeyId) : undefined;

  return withHostDefaults({
    id,
    name,
    address,
    port: numberValue(value.port, 22, 1, 65_535),
    username,
    authMethod,
    sshKeyId,
    privateKeyPath:
      authMethod === "privateKey" && !sshKeyId
        ? stringValue(value.privateKeyPath)
        : undefined,
    connectTimeoutSeconds: numberValue(
      value.connectTimeoutSeconds,
      10,
      1,
      120,
    ),
    keepAliveIntervalSeconds: numberValue(
      value.keepAliveIntervalSeconds,
      15,
      0,
      300,
    ),
    autoReconnect: optionalBoolean(value.autoReconnect) ?? true,
    maxReconnectAttempts: numberValue(value.maxReconnectAttempts, 3, 0, 10),
    proxyId: stringValue(value.proxyId),
    jumpHostId: stringValue(value.jumpHostId),
    localPortForwards: sanitizeList(
      value.localPortForwards,
      sanitizeLocalPortForward,
    ),
    remotePortForwards: sanitizeList(
      value.remotePortForwards,
      sanitizeRemotePortForward,
    ),
    dynamicPortForwards: sanitizeList(
      value.dynamicPortForwards,
      sanitizeDynamicPortForward,
    ),
    group: stringValue(value.group),
    hostFingerprint: stringValue(value.hostFingerprint),
    lastConnectedAt: stringValue(value.lastConnectedAt),
  });
}

function sanitizeHistoryRecord(
  value: unknown,
): ConnectionHistoryRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const address = stringValue(value.address);
  const username = stringValue(value.username);
  const connectedAt = stringValue(value.connectedAt);
  if (!id || !name || !address || !username || !connectedAt) return undefined;
  const authMethod =
    value.authMethod === "privateKey" || value.authMethod === "agent"
      ? value.authMethod
      : "password";
  const sshKeyId =
    authMethod === "privateKey" ? stringValue(value.sshKeyId) : undefined;

  return {
    id,
    hostId: stringValue(value.hostId),
    name,
    address,
    port: numberValue(value.port, 22, 1, 65_535),
    username,
    authMethod,
    sshKeyId,
    privateKeyPath:
      authMethod === "privateKey" && !sshKeyId
        ? stringValue(value.privateKeyPath)
        : undefined,
    hostFingerprint: stringValue(value.hostFingerprint),
    keepAliveIntervalSeconds: numberValue(
      value.keepAliveIntervalSeconds,
      15,
      0,
      300,
    ),
    autoReconnect: optionalBoolean(value.autoReconnect) ?? true,
    maxReconnectAttempts: numberValue(value.maxReconnectAttempts, 3, 0, 10),
    proxyId: stringValue(value.proxyId),
    jumpHostId: stringValue(value.jumpHostId),
    localPortForwards: sanitizeList(
      value.localPortForwards,
      sanitizeLocalPortForward,
    ),
    remotePortForwards: sanitizeList(
      value.remotePortForwards,
      sanitizeRemotePortForward,
    ),
    dynamicPortForwards: sanitizeList(
      value.dynamicPortForwards,
      sanitizeDynamicPortForward,
    ),
    connectedAt,
  };
}

function sanitizeKnownHost(value: unknown): KnownHostRecord | undefined {
  if (!isRecord(value)) return undefined;

  const address = stringValue(value.address)?.trim();
  const fingerprint = normalizeHostFingerprint(
    stringValue(value.fingerprint) ?? "",
  );
  if (!address || !fingerprint) return undefined;

  const port = numberValue(value.port, 22, 1, 65_535);
  const fallbackTime = new Date().toISOString();
  const lastVerifiedAtValue = stringValue(value.lastVerifiedAt);
  const lastVerifiedAt =
    lastVerifiedAtValue && Number.isFinite(Date.parse(lastVerifiedAtValue))
      ? lastVerifiedAtValue
      : fallbackTime;
  const firstSeenAtValue = stringValue(value.firstSeenAt);
  const firstSeenAt =
    firstSeenAtValue && Number.isFinite(Date.parse(firstSeenAtValue))
      ? firstSeenAtValue
      : lastVerifiedAt;

  return {
    id: stringValue(value.id) ?? knownHostRecordId(address, port),
    address,
    port,
    fingerprint,
    firstSeenAt:
      Date.parse(firstSeenAt) <= Date.parse(lastVerifiedAt)
        ? firstSeenAt
        : lastVerifiedAt,
    lastVerifiedAt,
  };
}

function sanitizeKnownHosts(value: unknown) {
  const records = sanitizeList(value, sanitizeKnownHost).sort(
    (left, right) =>
      Date.parse(left.lastVerifiedAt) - Date.parse(right.lastVerifiedAt),
  );
  let deduplicated: KnownHostRecord[] = [];
  for (const record of records) {
    const targetKey = knownHostTargetKey(record.address, record.port);
    const existing = deduplicated.find(
      (item) => knownHostTargetKey(item.address, item.port) === targetKey,
    );
    deduplicated = upsertKnownHostRecord(
      deduplicated,
      record,
      record.fingerprint,
      record.lastVerifiedAt,
    );
    deduplicated = deduplicated.map((item) =>
      knownHostTargetKey(item.address, item.port) === targetKey &&
      item.fingerprint === record.fingerprint
        ? {
            ...item,
            id: existing?.id ?? record.id,
            firstSeenAt:
              Date.parse(record.firstSeenAt) < Date.parse(item.firstSeenAt)
                ? record.firstSeenAt
                : item.firstSeenAt,
          }
        : item,
    );
  }
  return deduplicated.sort(
    (left, right) =>
      Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt),
  );
}

function sanitizeBackup(value: unknown): ConfigurationBackup | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const createdAt = stringValue(value.createdAt);
  const reason = stringValue(value.reason);
  if (!id || !createdAt || !reason) return undefined;

  const settings = isRecord(value.settings)
    ? sanitizeAppSettings(value.settings)
    : undefined;
  return {
    id,
    createdAt,
    reason,
    hosts: sanitizeList(value.hosts, sanitizeHost),
    history: applyConnectionHistoryPolicy(
      sanitizeList(value.history, sanitizeHistoryRecord),
      settings ?? DEFAULT_APP_SETTINGS,
      new Date(createdAt),
    ),
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    sshKeys: sanitizeList(value.sshKeys, sanitizeSshKey),
    quickCommands: sanitizeList(value.quickCommands, sanitizeQuickCommand),
    hostSort: sanitizeHostSortMode(value.hostSort),
    sftpLocations: sanitizeList(value.sftpLocations, sanitizeSftpLocation),
    knownHosts: Array.isArray(value.knownHosts)
      ? sanitizeKnownHosts(value.knownHosts)
      : undefined,
    settings,
  };
}

function sanitizeDeletedHost(value: unknown): DeletedHostRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const host = sanitizeHost(value.host);
  const deletedAt = stringValue(value.deletedAt);
  const expiresAt = stringValue(value.expiresAt);
  if (
    !id ||
    !host ||
    !deletedAt ||
    !expiresAt ||
    !Number.isFinite(Date.parse(deletedAt)) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return undefined;
  }

  return { id, host, deletedAt, expiresAt };
}

function sanitizeList<T>(
  value: unknown,
  sanitize: (item: unknown) => T | undefined,
) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const sanitized = sanitize(item);
    return sanitized ? [sanitized] : [];
  });
}

function parseLegacyList(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function migrateLegacyConfiguration(
  storedHosts: string | null,
  storedHistory: string | null,
  now = new Date().toISOString(),
): FineShellConfiguration {
  const hosts = sanitizeList(parseLegacyList(storedHosts), sanitizeHost);
  const history = applyConnectionHistoryPolicy(
    sanitizeList(parseLegacyList(storedHistory), sanitizeHistoryRecord),
    DEFAULT_APP_SETTINGS,
    new Date(now),
  );
  return {
    id: CONFIGURATION_ID,
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    hosts,
    history,
    proxies: [],
    sshKeys: [],
    quickCommands: [],
    hostSort: "manual",
    sftpLocations: [],
    knownHosts: deriveKnownHostRecords(hosts, history, now),
    terminalCommandHistory: [],
    settings: { ...DEFAULT_APP_SETTINGS },
    credentialReferences: [],
    backups: [],
    trash: [],
    updatedAt: now,
  };
}

function normalizeConfiguration(value: unknown): FineShellConfiguration {
  if (!isRecord(value)) return migrateLegacyConfiguration(null, null);
  if (
    typeof value.schemaVersion === "number" &&
    value.schemaVersion > CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new Error("配置由更高版本的 FineShell 创建，当前版本无法读取");
  }

  const hosts = sanitizeList(value.hosts, sanitizeHost);
  const settings = sanitizeAppSettings(value.settings);
  const updatedAt = stringValue(value.updatedAt) ?? new Date().toISOString();
  const history = applyConnectionHistoryPolicy(
    sanitizeList(value.history, sanitizeHistoryRecord),
    settings,
    new Date(),
  );
  return {
    id: CONFIGURATION_ID,
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    hosts,
    history,
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    sshKeys: sanitizeList(value.sshKeys, sanitizeSshKey),
    quickCommands: sanitizeList(value.quickCommands, sanitizeQuickCommand),
    hostSort: sanitizeHostSortMode(value.hostSort),
    sftpLocations: sanitizeList(value.sftpLocations, sanitizeSftpLocation),
    knownHosts: Array.isArray(value.knownHosts)
      ? sanitizeKnownHosts(value.knownHosts)
      : deriveKnownHostRecords(hosts, history, updatedAt),
    terminalCommandHistory: applyTerminalCommandHistoryPolicy(
      sanitizeList(
        value.terminalCommandHistory,
        sanitizeTerminalCommandHistoryRecord,
      ),
    ),
    settings,
    credentialReferences: sanitizeList(
      value.credentialReferences,
      sanitizeCredentialReference,
    ),
    backups: sanitizeList(value.backups, sanitizeBackup).slice(
      0,
      MAX_CONFIGURATION_BACKUPS,
    ),
    trash: sanitizeList(value.trash, sanitizeDeletedHost),
    updatedAt,
  };
}

export function createBackup(
  configuration: FineShellConfiguration,
  reason: string,
  now = new Date().toISOString(),
): ConfigurationBackup {
  return {
    id: `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    reason,
    hosts: configuration.hosts,
    history: configuration.history,
    proxies: configuration.proxies,
    sshKeys: configuration.sshKeys,
    quickCommands: configuration.quickCommands,
    hostSort: configuration.hostSort,
    sftpLocations: configuration.sftpLocations,
    knownHosts: configuration.knownHosts,
    settings: configuration.settings,
  };
}

export function serializeConfigurationExport(
  configuration: Pick<
    FineShellConfiguration,
    | "hosts"
    | "history"
    | "proxies"
    | "sshKeys"
    | "quickCommands"
    | "hostSort"
    | "sftpLocations"
    | "knownHosts"
    | "settings"
  >,
  now = new Date().toISOString(),
) {
  const settings = sanitizeAppSettings(configuration.settings);
  const exported: FineShellConfigurationExport = {
    format: "fineshell-config",
    schemaVersion: CONFIGURATION_EXPORT_VERSION,
    exportedAt: now,
    hosts: sanitizeList(configuration.hosts, sanitizeHost),
    history: applyConnectionHistoryPolicy(
      sanitizeList(configuration.history, sanitizeHistoryRecord),
      settings,
      new Date(now),
    ),
    proxies: sanitizeList(configuration.proxies, sanitizeProxy),
    sshKeys: sanitizeList(configuration.sshKeys, sanitizeSshKey),
    quickCommands: sanitizeList(
      configuration.quickCommands,
      sanitizeQuickCommand,
    ),
    hostSort: configuration.hostSort,
    sftpLocations: sanitizeList(
      configuration.sftpLocations,
      sanitizeSftpLocation,
    ),
    knownHosts: sanitizeKnownHosts(configuration.knownHosts),
    settings,
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}

export function parseConfigurationExport(contents: string) {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("配置文件不是有效的 JSON");
  }
  if (!isRecord(value) || value.format !== "fineshell-config") {
    throw new Error("不是 FineShell 配置文件");
  }
  if (
    typeof value.schemaVersion !== "number" ||
    value.schemaVersion > CONFIGURATION_EXPORT_VERSION
  ) {
    throw new Error("配置文件版本不受支持");
  }

  const hosts = sanitizeList(value.hosts, sanitizeHost);
  const settings = sanitizeAppSettings(value.settings);
  const exportedAt = stringValue(value.exportedAt) ?? new Date().toISOString();
  const history = applyConnectionHistoryPolicy(
    sanitizeList(value.history, sanitizeHistoryRecord),
    settings,
    new Date(),
  );
  return {
    hosts,
    history,
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    sshKeys: sanitizeList(value.sshKeys, sanitizeSshKey),
    quickCommands: sanitizeList(value.quickCommands, sanitizeQuickCommand),
    hostSort: sanitizeHostSortMode(value.hostSort),
    sftpLocations: sanitizeList(value.sftpLocations, sanitizeSftpLocation),
    knownHosts: Array.isArray(value.knownHosts)
      ? sanitizeKnownHosts(value.knownHosts)
      : deriveKnownHostRecords(
          hosts,
          history,
          exportedAt,
        ),
    settings,
  };
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("数据库请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("数据库事务已取消"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("数据库事务失败"));
  });
}

function openDatabase() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONFIGURATION_STORE)) {
        database.createObjectStore(CONFIGURATION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开本地配置数据库"));
    request.onblocked = () => reject(new Error("本地配置数据库升级被阻止"));
  });
  return databasePromise;
}

async function readConfigurationRecord(database: IDBDatabase) {
  const transaction = database.transaction(CONFIGURATION_STORE, "readonly");
  const completed = transactionDone(transaction);
  const value = await requestResult(
    transaction.objectStore(CONFIGURATION_STORE).get(CONFIGURATION_ID),
  );
  await completed;
  return value;
}

async function writeConfigurationRecord(
  database: IDBDatabase,
  configuration: FineShellConfiguration,
) {
  const transaction = database.transaction(CONFIGURATION_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CONFIGURATION_STORE).put(configuration);
  await completed;
}

async function initializeConfiguration() {
  const database = await openDatabase();
  const stored = await readConfigurationRecord(database);
  if (stored) {
    const normalized = normalizeConfiguration(stored);
    await writeConfigurationRecord(database, normalized);
    return;
  }

  let legacyHosts: string | null = null;
  let legacyHistory: string | null = null;
  try {
    legacyHosts = localStorage.getItem(HOSTS_STORAGE_KEY);
    legacyHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
  } catch {
    // Restricted webviews may deny localStorage access; an empty database is valid.
  }

  const migrated = migrateLegacyConfiguration(legacyHosts, legacyHistory);
  await writeConfigurationRecord(database, migrated);

  try {
    localStorage.removeItem(HOSTS_STORAGE_KEY);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // The database migration has completed even if legacy cache cleanup is denied.
  }
}

async function ensureInitialized() {
  initializationPromise ??= initializeConfiguration();
  await initializationPromise;
}

export async function loadConfiguration() {
  await ensureInitialized();
  const stored = await readConfigurationRecord(await openDatabase());
  return normalizeConfiguration(stored);
}

export async function updateConfiguration(
  update: (current: FineShellConfiguration) => FineShellConfiguration,
) {
  await ensureInitialized();
  const database = await openDatabase();
  const transaction = database.transaction(CONFIGURATION_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(CONFIGURATION_STORE);
  const current = normalizeConfiguration(
    await requestResult(store.get(CONFIGURATION_ID)),
  );
  const next = normalizeConfiguration({
    ...update(current),
    id: CONFIGURATION_ID,
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  });
  store.put(next);
  await completed;
  return next;
}
