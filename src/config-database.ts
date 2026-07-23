import { withHostDefaults } from "./host-storage";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "./app-settings";
import type {
  ConnectionHistoryRecord,
  HostRecord,
  HostSortMode,
  ProxyRecord,
} from "./models";

const DATABASE_NAME = "fineshell.config";
const DATABASE_VERSION = 1;
const CONFIGURATION_STORE = "configuration";
const CONFIGURATION_ID = "primary";
const HOSTS_STORAGE_KEY = "fineshell.hosts";
const HISTORY_STORAGE_KEY = "fineshell.connection-history";

export const CONFIGURATION_SCHEMA_VERSION = 7;
export const CONFIGURATION_EXPORT_VERSION = 5;
export const MAX_CONFIGURATION_BACKUPS = 10;
export const TRASH_RETENTION_DAYS = 30;

export interface ConfigurationBackup {
  id: string;
  createdAt: string;
  reason: string;
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  proxies: ProxyRecord[];
  hostSort: HostSortMode;
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
  hostSort: HostSortMode;
  settings: AppSettings;
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
  hostSort: HostSortMode;
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

function sanitizeHost(value: unknown): HostRecord | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const address = stringValue(value.address);
  const username = stringValue(value.username);
  if (!id || !name || !address || !username) return undefined;

  return withHostDefaults({
    id,
    name,
    address,
    port: numberValue(value.port, 22, 1, 65_535),
    username,
    authMethod: value.authMethod === "privateKey" ? "privateKey" : "password",
    privateKeyPath: stringValue(value.privateKeyPath),
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

  return {
    id,
    hostId: stringValue(value.hostId),
    name,
    address,
    port: numberValue(value.port, 22, 1, 65_535),
    username,
    authMethod: value.authMethod === "privateKey" ? "privateKey" : "password",
    privateKeyPath: stringValue(value.privateKeyPath),
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
    connectedAt,
  };
}

function sanitizeBackup(value: unknown): ConfigurationBackup | undefined {
  if (!isRecord(value)) return undefined;

  const id = stringValue(value.id);
  const createdAt = stringValue(value.createdAt);
  const reason = stringValue(value.reason);
  if (!id || !createdAt || !reason) return undefined;

  return {
    id,
    createdAt,
    reason,
    hosts: sanitizeList(value.hosts, sanitizeHost),
    history: sanitizeList(value.history, sanitizeHistoryRecord).slice(0, 50),
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    hostSort: sanitizeHostSortMode(value.hostSort),
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
  return {
    id: CONFIGURATION_ID,
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    hosts: sanitizeList(parseLegacyList(storedHosts), sanitizeHost),
    history: sanitizeList(
      parseLegacyList(storedHistory),
      sanitizeHistoryRecord,
    ).slice(0, 50),
    proxies: [],
    hostSort: "manual",
    settings: { ...DEFAULT_APP_SETTINGS },
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

  return {
    id: CONFIGURATION_ID,
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    hosts: sanitizeList(value.hosts, sanitizeHost),
    history: sanitizeList(value.history, sanitizeHistoryRecord).slice(0, 50),
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    hostSort: sanitizeHostSortMode(value.hostSort),
    settings: sanitizeAppSettings(value.settings),
    backups: sanitizeList(value.backups, sanitizeBackup).slice(
      0,
      MAX_CONFIGURATION_BACKUPS,
    ),
    trash: sanitizeList(value.trash, sanitizeDeletedHost),
    updatedAt: stringValue(value.updatedAt) ?? new Date().toISOString(),
  };
}

function createBackup(
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
    hostSort: configuration.hostSort,
  };
}

export function serializeConfigurationExport(
  configuration: Pick<
    FineShellConfiguration,
    "hosts" | "history" | "proxies" | "hostSort" | "settings"
  >,
  now = new Date().toISOString(),
) {
  const exported: FineShellConfigurationExport = {
    format: "fineshell-config",
    schemaVersion: CONFIGURATION_EXPORT_VERSION,
    exportedAt: now,
    hosts: sanitizeList(configuration.hosts, sanitizeHost),
    history: sanitizeList(
      configuration.history,
      sanitizeHistoryRecord,
    ).slice(0, 50),
    proxies: sanitizeList(configuration.proxies, sanitizeProxy),
    hostSort: configuration.hostSort,
    settings: sanitizeAppSettings(configuration.settings),
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

  return {
    hosts: sanitizeList(value.hosts, sanitizeHost),
    history: sanitizeList(value.history, sanitizeHistoryRecord).slice(0, 50),
    proxies: sanitizeList(value.proxies, sanitizeProxy),
    hostSort: sanitizeHostSortMode(value.hostSort),
    settings: sanitizeAppSettings(value.settings),
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

export function replaceConfigurationContent(
  hosts: HostRecord[],
  history: ConnectionHistoryRecord[],
) {
  return updateConfiguration((current) => ({
    ...current,
    hosts,
    history,
  }));
}

export function updateStoredHostFingerprint(
  host: Pick<HostRecord, "id" | "address" | "port" | "username">,
  fingerprint: string,
) {
  return updateConfiguration((current) => ({
    ...current,
    hosts: host.id.startsWith("quick-")
      ? current.hosts
      : current.hosts.map((item) =>
          item.id === host.id
            ? { ...item, hostFingerprint: fingerprint }
            : item,
        ),
    history: current.history.map((item) =>
      item.username === host.username &&
      item.address === host.address &&
      item.port === host.port
        ? { ...item, hostFingerprint: fingerprint }
        : item,
    ),
  }));
}

export function importConfiguration(
  imported: Pick<
    FineShellConfiguration,
    "hosts" | "history" | "proxies" | "hostSort" | "settings"
  >,
) {
  return updateConfiguration((current) => ({
    ...current,
    hosts: imported.hosts,
    history: imported.history,
    proxies: imported.proxies,
    hostSort: imported.hostSort,
    settings: imported.settings,
    backups: [
      createBackup(current, "导入配置前自动备份"),
      ...current.backups,
    ].slice(0, MAX_CONFIGURATION_BACKUPS),
  }));
}

export function restoreConfigurationBackup(backupId: string) {
  return updateConfiguration((current) => {
    const backup = current.backups.find((item) => item.id === backupId);
    if (!backup) throw new Error("备份不存在或已被清理");

    return {
      ...current,
      hosts: backup.hosts,
      history: backup.history,
      proxies: backup.proxies,
      hostSort: backup.hostSort,
      backups: [
        createBackup(current, "恢复配置前自动备份"),
        ...current.backups,
      ].slice(0, MAX_CONFIGURATION_BACKUPS),
    };
  });
}

export function createDeletedHostRecord(
  host: HostRecord,
  now = new Date(),
): DeletedHostRecord {
  const deletedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    id: `trash-${host.id}-${now.getTime()}`,
    host,
    deletedAt,
    expiresAt,
  };
}

export function isDeletedHostExpired(
  deletedHost: Pick<DeletedHostRecord, "expiresAt">,
  now = new Date(),
) {
  return Date.parse(deletedHost.expiresAt) <= now.getTime();
}

export function moveHostToTrash(hostId: string) {
  return updateConfiguration((current) => {
    const host = current.hosts.find((item) => item.id === hostId);
    if (!host) throw new Error("主机不存在或已被删除");

    return {
      ...current,
      hosts: current.hosts
        .filter((item) => item.id !== hostId)
        .map((item) =>
          item.jumpHostId === hostId
            ? { ...item, jumpHostId: undefined }
            : item,
        ),
      history: current.history.map((record) =>
        record.jumpHostId === hostId
          ? { ...record, jumpHostId: undefined }
          : record,
      ),
      backups: [
        createBackup(current, "删除主机前自动备份"),
        ...current.backups,
      ].slice(0, MAX_CONFIGURATION_BACKUPS),
      trash: [
        createDeletedHostRecord(host),
        ...current.trash.filter((item) => item.host.id !== hostId),
      ],
    };
  });
}

export function restoreDeletedHost(deletedHostId: string) {
  return updateConfiguration((current) => {
    const deletedHost = current.trash.find(
      (item) => item.id === deletedHostId,
    );
    if (!deletedHost) throw new Error("回收站记录不存在或已过期");
    if (current.hosts.some((item) => item.id === deletedHost.host.id)) {
      throw new Error("当前主机列表中已存在同一主机，无法恢复");
    }

    return {
      ...current,
      hosts: [...current.hosts, deletedHost.host],
      trash: current.trash.filter((item) => item.id !== deletedHostId),
    };
  });
}

export function permanentlyDeleteHost(deletedHostId: string) {
  return updateConfiguration((current) => ({
    ...current,
    trash: current.trash.filter((item) => item.id !== deletedHostId),
  }));
}

export async function purgeExpiredDeletedHosts(now = new Date()) {
  const expiredHostIds: string[] = [];
  const configuration = await updateConfiguration((current) => ({
    ...current,
    trash: current.trash.filter((item) => {
      if (!isDeletedHostExpired(item, now)) return true;
      if (!current.hosts.some((host) => host.id === item.host.id)) {
        expiredHostIds.push(item.host.id);
      }
      return false;
    }),
  }));
  return { configuration, expiredHostIds };
}

export function updateHostSortMode(hostSort: HostSortMode) {
  return updateConfiguration((current) => ({ ...current, hostSort }));
}

export function upsertProxy(proxy: ProxyRecord) {
  return updateConfiguration((current) => ({
    ...current,
    proxies: current.proxies.some((item) => item.id === proxy.id)
      ? current.proxies.map((item) => (item.id === proxy.id ? proxy : item))
      : [...current.proxies, proxy],
  }));
}

export function deleteProxy(proxyId: string) {
  return updateConfiguration((current) => ({
    ...current,
    proxies: current.proxies.filter((item) => item.id !== proxyId),
    hosts: current.hosts.map((host) =>
      host.proxyId === proxyId ? { ...host, proxyId: undefined } : host,
    ),
    history: current.history.map((record) =>
      record.proxyId === proxyId
        ? { ...record, proxyId: undefined }
        : record,
    ),
  }));
}

export function updateAppSettings(settings: AppSettings) {
  return updateConfiguration((current) => ({
    ...current,
    settings: sanitizeAppSettings(settings),
  }));
}
