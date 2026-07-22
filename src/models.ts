export type HostAuthMethod = "password" | "privateKey";

export interface HostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: HostAuthMethod;
  privateKeyPath?: string;
  connectTimeoutSeconds: number;
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
