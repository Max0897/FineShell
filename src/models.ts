export type HostAuthMethod = "password" | "privateKey";
export type HostSortMode =
  | "manual"
  | "nameAsc"
  | "nameDesc"
  | "addressAsc"
  | "recentDesc";

export interface HostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: HostAuthMethod;
  privateKeyPath?: string;
  connectTimeoutSeconds: number;
  keepAliveIntervalSeconds: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  group?: string;
  hostFingerprint?: string;
  lastConnectedAt?: string;
}

export interface HostFormValues {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: HostAuthMethod;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  connectTimeoutSeconds: number;
  keepAliveIntervalSeconds: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  password?: string;
  group?: string;
  hostFingerprint?: string;
}

export interface QuickTarget {
  address: string;
  port: number;
  username: string;
}

export interface ConnectionHistoryRecord extends QuickTarget {
  id: string;
  hostId?: string;
  name: string;
  authMethod?: HostAuthMethod;
  privateKeyPath?: string;
  hostFingerprint?: string;
  keepAliveIntervalSeconds?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  connectedAt: string;
}

export type TerminalSessionStatus =
  | "connecting"
  | "connected"
  | "failed"
  | "disconnected"
  | "reconnecting";

export interface TerminalSession {
  id: string;
  host: HostRecord;
  openedAt: string;
  status: TerminalSessionStatus;
  error?: string;
  fingerprint?: string;
  reconnectAttempt?: number;
}

export interface ServerMonitorSnapshot {
  hostname: string;
  operatingSystem: string;
  kernel: string;
  uptimeSeconds: number;
  cpuUsagePercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePercent: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskUsagePercent: number;
  loadAverage: [number, number, number];
  networkReceiveBytes: number;
  networkTransmitBytes: number;
}

export interface ServerMonitorHistoryPoint {
  collectedAt: number;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  networkReceiveBytes: number;
  networkTransmitBytes: number;
  networkReceiveBytesPerSecond: number;
  networkTransmitBytesPerSecond: number;
}

export interface NetworkPingResult {
  target: string;
  reachable: boolean;
  transmitted: number;
  received: number;
  packetLossPercent: number;
  minimumLatencyMs?: number;
  averageLatencyMs?: number;
  maximumLatencyMs?: number;
}

export interface NetworkConnection {
  id: string;
  protocol: string;
  state: string;
  localAddress: string;
  localPort: string;
  remoteAddress: string;
  remotePort: string;
  process?: string;
}

export interface NetworkConnectionsResult {
  connections: NetworkConnection[];
  truncated: boolean;
}

export interface NetworkRouteHop {
  hop: number;
  address?: string;
  latencyMs?: number;
}

export interface NetworkTraceResult {
  target: string;
  resolvedAddress?: string;
  reached: boolean;
  hops: NetworkRouteHop[];
}

export type SftpEntryKind = "directory" | "file" | "symlink" | "other";

export interface SftpEntry {
  id: string;
  name: string;
  path: string;
  kind: SftpEntryKind;
  size: number;
  modifiedAt?: number;
  permissions?: number;
}

export interface SftpListResult {
  path: string;
  entries: SftpEntry[];
}

export interface SftpConnectResult {
  fingerprint: string;
  homeDir: string;
}
