import type {
  NetworkConnectionsResult,
  NetworkPingResult,
  NetworkTraceResult,
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
  ServerProcess,
  SftpEntry,
} from "./models";
import type { AiContextSource } from "./ai-utils";

const MAX_PROCESS_CONTEXT_ITEMS = 20;
const MAX_NETWORK_CONNECTION_ITEMS = 30;
const MAX_MONITOR_HISTORY_ITEMS = 24;
const MAX_SFTP_CONTEXT_ITEMS = 50;

export interface AiHandoffRequest {
  prompt: string;
  source: AiContextSource;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

export function createMonitorAiHandoff(
  snapshot: ServerMonitorSnapshot,
  history: ServerMonitorHistoryPoint[],
): AiHandoffRequest {
  const recentHistory = history
    .slice(-MAX_MONITOR_HISTORY_ITEMS)
    .map((point) => ({
      collectedAt: new Date(point.collectedAt).toISOString(),
      cpuUsagePercent: rounded(point.cpuUsagePercent),
      memoryUsagePercent: rounded(point.memoryUsagePercent),
      networkReceiveBytesPerSecond: Math.round(
        point.networkReceiveBytesPerSecond,
      ),
      networkTransmitBytesPerSecond: Math.round(
        point.networkTransmitBytesPerSecond,
      ),
    }));
  return {
    prompt:
      "请分析当前服务器资源状态和近期趋势，指出异常、可能原因与建议的只读排查步骤。",
    source: {
      id: "server-trend",
      label: "服务器资源趋势",
      content: JSON.stringify({ snapshot, recentHistory }, null, 2),
      preserveWhitespace: true,
      truncateFrom: "start",
    },
  };
}

export function createProcessesAiHandoff(
  processes: ServerProcess[],
): AiHandoffRequest {
  const selected = processes
    .slice(0, MAX_PROCESS_CONTEXT_ITEMS)
    .map((process) => ({
      pid: process.pid,
      parentPid: process.parentPid,
      name: process.name,
      user: process.user,
      state: process.state,
      cpuUsagePercent: rounded(process.cpuUsagePercent),
      memoryUsagePercent: rounded(process.memoryUsagePercent),
      residentMemoryBytes: process.residentMemoryBytes,
      elapsedSeconds: process.elapsedSeconds,
      command: process.command,
    }));
  return {
    prompt:
      "请分析这些进程的资源占用和运行状态，指出值得关注的进程，并给出安全的排查建议。",
    source: {
      id: "process-selection",
      label: `所选进程(${selected.length})`,
      content: JSON.stringify(
        {
          selected,
          omitted: Math.max(0, processes.length - selected.length),
        },
        null,
        2,
      ),
      preserveWhitespace: true,
    },
  };
}

export function createNetworkAiHandoff(input: {
  connections: NetworkConnectionsResult | null;
  ping: NetworkPingResult | null;
  trace: NetworkTraceResult | null;
}): AiHandoffRequest {
  const connections = input.connections?.connections
    .slice(0, MAX_NETWORK_CONNECTION_ITEMS)
    .map((connection) => ({
      protocol: connection.protocol,
      state: connection.state,
      local: `${connection.localAddress}:${connection.localPort}`,
      remote: `${connection.remoteAddress}:${connection.remotePort}`,
      process: connection.process,
    }));
  return {
    prompt: "请综合分析这些网络诊断结果，判断可疑点并给出下一步只读排查建议。",
    source: {
      id: "network-diagnostic",
      label: "网络诊断结果",
      content: JSON.stringify(
        {
          ping: input.ping,
          trace: input.trace,
          connections,
          connectionsOmitted: Math.max(
            0,
            (input.connections?.connections.length ?? 0) -
              (connections?.length ?? 0),
          ),
          connectionsTruncated: input.connections?.truncated ?? false,
        },
        null,
        2,
      ),
      preserveWhitespace: true,
    },
  };
}

export function createSftpSelectionAiHandoff(
  currentDirectory: string,
  entries: SftpEntry[],
): AiHandoffRequest {
  const selected = entries.slice(0, MAX_SFTP_CONTEXT_ITEMS).map((entry) => ({
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    permissions: entry.permissions,
    owner: entry.owner,
    group: entry.group,
  }));
  return {
    prompt:
      "请分析所选远程文件或目录，说明其用途、潜在风险，并给出后续操作建议。",
    source: {
      id: "sftp-selection",
      label: `所选远程项目(${selected.length})`,
      content: JSON.stringify(
        {
          currentDirectory,
          selected,
          omitted: Math.max(0, entries.length - selected.length),
        },
        null,
        2,
      ),
      preserveWhitespace: true,
    },
  };
}
