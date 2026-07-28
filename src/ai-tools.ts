import type {
  NetworkConnectionsResult,
  NetworkPingResult,
  NetworkTraceResult,
  ServerMonitorSnapshot,
  ServerProcessListResult,
} from "./models";
import type { AiToolCall, AiToolResult } from "./tauri-protocol";
import { redactAiContext } from "./ai-utils";
import {
  isAiReadOnlyToolName,
  type AiReadOnlyToolName,
} from "./ai-permissions";

export type { AiReadOnlyToolName } from "./ai-permissions";
export { isAiReadOnlyToolName } from "./ai-permissions";

export type AiToolRunStatus =
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface AiToolRun {
  callId: string;
  detail?: string;
  durationMs?: number;
  error?: string;
  label: string;
  name: AiReadOnlyToolName;
  summary?: string;
  startedAt: number;
  status: AiToolRunStatus;
}

export const MAX_AI_TOOL_ROUNDS = 3;

const TOOL_LABELS: Record<AiReadOnlyToolName, string> = {
  get_server_status: "读取服务器状态",
  list_processes: "读取进程列表",
  get_current_directory: "读取当前目录",
  get_network_connections: "读取网络连接",
  ping_target: "Ping",
  trace_route: "路由追踪",
};

const TARGET_TOOLS = new Set<AiReadOnlyToolName>([
  "ping_target",
  "trace_route",
]);
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSafeText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? redactAiContext(value.trim()).slice(0, maxLength)
    : undefined;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function percent(value: unknown) {
  const number = finiteNumber(value);
  return number === undefined ? "-" : `${number.toFixed(1)}%`;
}

function toolArguments(call: AiToolCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error(`AI 返回了无效的工具参数：${call.name}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`AI 返回了无效的工具参数：${call.name}`);
  }
  return value as Record<string, unknown>;
}

export function aiToolTarget(call: AiToolCall): string | undefined {
  if (!isAiReadOnlyToolName(call.name) || !TARGET_TOOLS.has(call.name)) {
    return undefined;
  }
  const target = toolArguments(call).target;
  if (
    typeof target !== "string" ||
    !target.trim() ||
    target.trim().length > 253 ||
    target.trim().startsWith("-") ||
    !/^[A-Za-z0-9._:-]+$/.test(target.trim())
  ) {
    throw new Error("AI 提供的网络诊断目标格式无效");
  }
  return target.trim();
}

export function aiToolRequiresConfirmation(name: string) {
  return isAiReadOnlyToolName(name) && TARGET_TOOLS.has(name);
}

export function aiToolLabel(name: string) {
  return isAiReadOnlyToolName(name) ? TOOL_LABELS[name] : "未知只读工具";
}

export function createAiToolRun(
  call: AiToolCall,
  startedAt = Date.now(),
): AiToolRun {
  if (!isAiReadOnlyToolName(call.name)) {
    throw new Error(`AI 请求了不支持的工具：${call.name}`);
  }
  return {
    callId: call.id,
    detail: aiToolTarget(call),
    label: aiToolLabel(call.name),
    name: call.name,
    startedAt,
    status: "running",
  };
}

export function finishAiToolRun(
  run: AiToolRun,
  completion: {
    error?: string;
    status?: "success" | "failed" | "cancelled";
    summary?: string;
  } = {},
  finishedAt = Date.now(),
): AiToolRun {
  const error = boundedSafeText(completion.error, 300);
  const summary = boundedSafeText(completion.summary, 4_000);
  return {
    ...run,
    durationMs: Math.max(0, finishedAt - run.startedAt),
    error,
    summary,
    status: completion.status ?? (error ? "failed" : "success"),
  };
}

export function restartAiToolRun(run: AiToolRun, startedAt = Date.now()) {
  return {
    ...run,
    durationMs: undefined,
    error: undefined,
    summary: undefined,
    startedAt,
    status: "running" as const,
  };
}

export function aiToolCallFromRun(run: AiToolRun): AiToolCall {
  return {
    id: run.callId,
    name: run.name,
    arguments: run.detail ? JSON.stringify({ target: run.detail }) : "{}",
  };
}

export function aiToolResult(
  call: AiToolCall,
  value: unknown,
): AiToolResult {
  return {
    callId: call.id,
    name: call.name,
    content: redactAiContext(JSON.stringify(value) ?? "null"),
  };
}

export function aiToolResultSummary(
  call: AiToolCall,
  result: AiToolResult,
) {
  let value: unknown;
  try {
    value = JSON.parse(result.content);
  } catch {
    return "诊断结果格式不可用";
  }
  if (!isRecord(value)) return "诊断结果格式不可用";
  if (value.ok === false) {
    return boundedSafeText(value.error, 300) ?? "诊断未完成";
  }
  let summary: string;
  switch (call.name) {
    case "get_server_status": {
      const memory = isRecord(value.memory) ? value.memory : {};
      const disk = isRecord(value.disk) ? value.disk : {};
      const load = Array.isArray(value.loadAverage)
        ? value.loadAverage
            .slice(0, 3)
            .map((item) => finiteNumber(item)?.toFixed(2) ?? "-")
            .join(" / ")
        : "-";
      summary = [
        `系统：${boundedSafeText(value.operatingSystem, 120) ?? "-"}`,
        `CPU：${percent(value.cpuUsagePercent)} · 内存：${percent(memory.usagePercent)} · 磁盘：${percent(disk.usagePercent)}`,
        `负载：${load}`,
      ].join("\n");
      break;
    }
    case "list_processes": {
      const processes = Array.isArray(value.processes) ? value.processes : [];
      const names = processes
        .slice(0, 5)
        .map((process) =>
          isRecord(process) ? boundedSafeText(process.name, 80) : undefined,
        )
        .filter((name): name is string => Boolean(name));
      summary = `进程总数：${finiteNumber(value.total) ?? "-"} · 返回：${finiteNumber(value.returned) ?? processes.length}${names.length ? `\n高占用进程：${names.join("、")}` : ""}`;
      break;
    }
    case "get_current_directory":
      summary = `当前目录：${boundedSafeText(value.path, 500) ?? "-"}`;
      break;
    case "get_network_connections": {
      const connections = Array.isArray(value.connections)
        ? value.connections
        : [];
      const states = new Map<string, number>();
      for (const connection of connections) {
        if (!isRecord(connection)) continue;
        const state = boundedSafeText(connection.state, 24) ?? "UNKNOWN";
        states.set(state, (states.get(state) ?? 0) + 1);
      }
      const stateSummary = Array.from(states.entries())
        .slice(0, 6)
        .map(([state, count]) => `${state} ${count}`)
        .join(" · ");
      summary = `连接总数：${finiteNumber(value.total) ?? "-"} · 返回：${finiteNumber(value.returned) ?? connections.length}${stateSummary ? `\n状态：${stateSummary}` : ""}`;
      break;
    }
    case "ping_target":
      summary = [
        `目标：${boundedSafeText(value.target, 253) ?? aiToolTarget(call) ?? "-"}`,
        `状态：${value.reachable === true ? "可达" : "不可达"} · 丢包：${percent(value.packetLossPercent)}`,
        `平均延迟：${finiteNumber(value.averageLatencyMs)?.toFixed(1) ?? "-"} ms`,
      ].join("\n");
      break;
    case "trace_route": {
      const hops = Array.isArray(value.hops) ? value.hops : [];
      summary = [
        `目标：${boundedSafeText(value.target, 253) ?? aiToolTarget(call) ?? "-"}`,
        `状态：${value.reached === true ? "已到达" : "未到达"} · 跳数：${hops.length}`,
      ].join("\n");
      break;
    }
    default:
      summary = "诊断已完成";
  }
  return boundedSafeText(summary, 4_000) ?? "诊断已完成";
}

export function sanitizePersistedAiToolRuns(value: unknown): AiToolRun[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const runs = value
    .map((item): AiToolRun | undefined => {
      if (!isRecord(item) || !isAiReadOnlyToolName(String(item.name ?? ""))) {
        return undefined;
      }
      if (
        item.status !== "success" &&
        item.status !== "failed" &&
        item.status !== "cancelled"
      ) {
        return undefined;
      }
      const name = String(item.name) as AiReadOnlyToolName;
      const callId = boundedSafeText(item.callId, 160);
      if (!callId) return undefined;
      const duration = finiteNumber(item.durationMs);
      const startedAt = finiteNumber(item.startedAt);
      return {
        callId,
        detail: boundedSafeText(item.detail, 253),
        durationMs:
          duration === undefined
            ? undefined
            : Math.min(60_000, Math.max(0, Math.round(duration))),
        error: boundedSafeText(item.error, 300),
        label: TOOL_LABELS[name],
        name,
        startedAt:
          startedAt === undefined ||
          startedAt < 0 ||
          startedAt > MAX_DATE_TIMESTAMP
            ? 0
            : Math.round(startedAt),
        status: item.status,
        summary: boundedSafeText(item.summary, 4_000),
      };
    })
    .filter((run): run is AiToolRun => Boolean(run))
    .slice(-12);
  return runs.length ? runs : undefined;
}

export function serverStatusToolValue(snapshot: ServerMonitorSnapshot) {
  return {
    ok: true,
    hostname: snapshot.hostname,
    operatingSystem: snapshot.operatingSystem,
    kernel: snapshot.kernel,
    uptimeSeconds: snapshot.uptimeSeconds,
    loadAverage: snapshot.loadAverage,
    cpuUsagePercent: snapshot.cpuUsagePercent,
    memory: {
      usedBytes: snapshot.memoryUsedBytes,
      totalBytes: snapshot.memoryTotalBytes,
      usagePercent: snapshot.memoryUsagePercent,
    },
    disk: {
      usedBytes: snapshot.diskUsedBytes,
      totalBytes: snapshot.diskTotalBytes,
      usagePercent: snapshot.diskUsagePercent,
    },
    network: {
      receivedBytes: snapshot.networkReceiveBytes,
      transmittedBytes: snapshot.networkTransmitBytes,
    },
  };
}

export function processListToolValue(
  result: ServerProcessListResult,
  limit = 15,
) {
  const processes = [...result.processes]
    .sort(
      (left, right) =>
        right.cpuUsagePercent - left.cpuUsagePercent ||
        right.memoryUsagePercent - left.memoryUsagePercent,
    )
    .slice(0, Math.max(1, limit))
    .map((process) => ({
      pid: process.pid,
      parentPid: process.parentPid,
      user: process.user,
      state: process.state,
      cpuUsagePercent: process.cpuUsagePercent,
      memoryUsagePercent: process.memoryUsagePercent,
      residentMemoryBytes: process.residentMemoryBytes,
      elapsedSeconds: process.elapsedSeconds,
      name: process.name,
      command: process.command.slice(0, 300),
    }));
  return {
    ok: true,
    total: result.processes.length,
    returned: processes.length,
    truncated: result.truncated || processes.length < result.processes.length,
    processes,
  };
}

export function currentDirectoryToolValue(path: string) {
  const normalized = path.trim();
  return normalized
    ? { ok: true, path: normalized }
    : { ok: false, error: "SFTP 当前目录尚不可用" };
}

export function networkConnectionsToolValue(
  result: NetworkConnectionsResult,
  limit = 40,
) {
  const connections = result.connections
    .slice(0, Math.min(50, Math.max(1, limit)))
    .map((connection) => ({
      protocol: connection.protocol,
      state: connection.state,
      localAddress: connection.localAddress,
      localPort: connection.localPort,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      process: connection.process?.slice(0, 200),
    }));
  return {
    ok: true,
    total: result.connections.length,
    returned: connections.length,
    truncated:
      result.truncated || connections.length < result.connections.length,
    connections,
  };
}

export function pingToolValue(result: NetworkPingResult) {
  return {
    ok: true,
    target: result.target,
    reachable: result.reachable,
    transmitted: result.transmitted,
    received: result.received,
    packetLossPercent: result.packetLossPercent,
    minimumLatencyMs: result.minimumLatencyMs,
    averageLatencyMs: result.averageLatencyMs,
    maximumLatencyMs: result.maximumLatencyMs,
  };
}

export function traceRouteToolValue(result: NetworkTraceResult) {
  return {
    ok: true,
    target: result.target,
    resolvedAddress: result.resolvedAddress,
    reached: result.reached,
    hops: result.hops.slice(0, 12).map((hop) => ({
      hop: hop.hop,
      address: hop.address,
      latencyMs: hop.latencyMs,
    })),
  };
}
