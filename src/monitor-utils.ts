import type {
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
} from "./models";

export function appendMonitorHistory(
  history: ServerMonitorHistoryPoint[],
  snapshot: ServerMonitorSnapshot,
  collectedAt = Date.now(),
  limit = 24,
) {
  const previous = history[history.length - 1];
  const elapsedSeconds = previous
    ? (collectedAt - previous.collectedAt) / 1_000
    : 0;
  const receiveBytesPerSecond =
    previous && elapsedSeconds > 0
      ? Math.max(
          0,
          (snapshot.networkReceiveBytes - previous.networkReceiveBytes) /
            elapsedSeconds,
        )
      : 0;
  const transmitBytesPerSecond =
    previous && elapsedSeconds > 0
      ? Math.max(
          0,
          (snapshot.networkTransmitBytes - previous.networkTransmitBytes) /
            elapsedSeconds,
        )
      : 0;

  return [
    ...history,
    {
      collectedAt,
      cpuUsagePercent: snapshot.cpuUsagePercent,
      memoryUsagePercent: snapshot.memoryUsagePercent,
      networkReceiveBytes: snapshot.networkReceiveBytes,
      networkTransmitBytes: snapshot.networkTransmitBytes,
      networkReceiveBytesPerSecond: receiveBytesPerSecond,
      networkTransmitBytesPerSecond: transmitBytesPerSecond,
    },
  ].slice(-Math.max(1, limit));
}

export function formatMonitorBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatMonitorRate(bytesPerSecond: number) {
  return `${formatMonitorBytes(bytesPerSecond)}/s`;
}

export function formatLatency(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  return `${milliseconds.toFixed(milliseconds >= 10 ? 1 : 2)} ms`;
}

export function formatNetworkEndpoint(address: string, port: string) {
  if (!port) return address;
  const displayAddress = address.includes(":") ? `[${address}]` : address;
  return `${displayAddress}:${port}`;
}

export function formatMonitorPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value)}%`;
}

export function normalizeMonitorPercent(value: unknown) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    return value;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? formatMonitorPercent(numericValue)
    : undefined;
}

export function formatUptime(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}
