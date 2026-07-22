import { withHostDefaults } from "./host-storage";
import type { ConnectionHistoryRecord, HostRecord } from "./models";

const DATABASE_NAME = "fineshell.config";
const DATABASE_VERSION = 1;
const CONFIGURATION_STORE = "configuration";
const CONFIGURATION_ID = "primary";
const HOSTS_STORAGE_KEY = "fineshell.hosts";
const HISTORY_STORAGE_KEY = "fineshell.connection-history";

export const CONFIGURATION_SCHEMA_VERSION = 1;

export interface FineShellConfiguration {
  id: typeof CONFIGURATION_ID;
  schemaVersion: typeof CONFIGURATION_SCHEMA_VERSION;
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  updatedAt: string;
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
    connectedAt,
  };
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
    updatedAt: stringValue(value.updatedAt) ?? new Date().toISOString(),
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
