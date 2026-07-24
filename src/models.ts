export type HostAuthMethod = "password" | "privateKey" | "agent";
export type HostSortMode =
  | "manual"
  | "nameAsc"
  | "nameDesc"
  | "addressAsc"
  | "recentDesc";

export type ProxyType = "socks5" | "http";

export interface ProxyRecord {
  id: string;
  name: string;
  type: ProxyType;
  address: string;
  port: number;
  username?: string;
}

export interface ProxyFormValues extends Omit<ProxyRecord, "id"> {
  password?: string;
}

export interface SshKeyRecord {
  id: string;
  name: string;
  privateKeyPath: string;
}

export interface SshKeyFormValues extends Omit<SshKeyRecord, "id"> {
  passphrase?: string;
}

export interface QuickCommandRecord {
  id: string;
  name: string;
  command: string;
  group?: string;
  description?: string;
}

export type QuickCommandFormValues = Omit<QuickCommandRecord, "id">;

export interface LocalPortForwardRule {
  id: string;
  name: string;
  bindAddress: string;
  bindPort: number;
  targetAddress: string;
  targetPort: number;
  enabled: boolean;
}

export interface RemotePortForwardRule {
  id: string;
  name: string;
  bindAddress: string;
  bindPort: number;
  targetAddress: string;
  targetPort: number;
  enabled: boolean;
}

export interface DynamicPortForwardRule {
  id: string;
  name: string;
  bindAddress: string;
  bindPort: number;
  enabled: boolean;
}

export interface PortForwardStatus {
  ruleId: string;
  kind: "local" | "remote" | "dynamic";
  status: "active" | "stopped" | "failed";
  bindAddress: string;
  bindPort: number;
  error?: string;
}

export interface HostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: HostAuthMethod;
  sshKeyId?: string;
  privateKeyPath?: string;
  connectTimeoutSeconds: number;
  keepAliveIntervalSeconds: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  proxyId?: string;
  jumpHostId?: string;
  localPortForwards?: LocalPortForwardRule[];
  remotePortForwards?: RemotePortForwardRule[];
  dynamicPortForwards?: DynamicPortForwardRule[];
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
  sshKeyId?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  connectTimeoutSeconds: number;
  keepAliveIntervalSeconds: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  proxyId?: string;
  jumpHostId?: string;
  localPortForwards?: LocalPortForwardRule[];
  remotePortForwards?: RemotePortForwardRule[];
  dynamicPortForwards?: DynamicPortForwardRule[];
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
  sshKeyId?: string;
  privateKeyPath?: string;
  hostFingerprint?: string;
  keepAliveIntervalSeconds?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  proxyId?: string;
  jumpHostId?: string;
  localPortForwards?: LocalPortForwardRule[];
  remotePortForwards?: RemotePortForwardRule[];
  dynamicPortForwards?: DynamicPortForwardRule[];
  connectedAt: string;
}

export interface JumpHostConnection {
  host: HostRecord;
  proxy?: ProxyRecord;
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
  proxy?: ProxyRecord;
  jumpHost?: JumpHostConnection;
  openedAt: string;
  status: TerminalSessionStatus;
  error?: string;
  fingerprint?: string;
  reconnectAttempt?: number;
  portForwardStatuses?: PortForwardStatus[];
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

export interface ServerProcess {
  id: string;
  pid: number;
  parentPid: number;
  user: string;
  state: string;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  residentMemoryBytes: number;
  elapsedSeconds: number;
  name: string;
  command: string;
}

export interface ServerProcessListResult {
  processes: ServerProcess[];
  truncated: boolean;
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

export interface SftpLocationRecord {
  hostId: string;
  bookmarks: string[];
  history: string[];
}

export interface SftpListResult {
  path: string;
  entries: SftpEntry[];
}

export interface SftpConnectResult {
  fingerprint: string;
  homeDir: string;
}
