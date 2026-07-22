export interface HostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group?: string;
  lastConnectedAt?: string;
}

export interface HostFormValues {
  name: string;
  address: string;
  port: number;
  username: string;
  group?: string;
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
  connectedAt: string;
}

export interface TerminalSession {
  id: string;
  host: HostRecord;
  openedAt: string;
}
