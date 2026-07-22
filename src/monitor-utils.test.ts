import { describe, expect, test } from "bun:test";
import type { ServerMonitorSnapshot } from "./models";
import {
  appendMonitorHistory,
  formatLatency,
  formatMonitorBytes,
  formatMonitorPercent,
  formatMonitorRate,
  formatNetworkEndpoint,
  formatUptime,
  normalizeMonitorPercent,
} from "./monitor-utils";

const snapshot: ServerMonitorSnapshot = {
  hostname: "server",
  operatingSystem: "Linux",
  kernel: "6.8.0",
  uptimeSeconds: 90_000,
  cpuUsagePercent: 25,
  memoryTotalBytes: 8 * 1024 ** 3,
  memoryUsedBytes: 4 * 1024 ** 3,
  memoryUsagePercent: 50,
  diskTotalBytes: 100 * 1024 ** 3,
  diskUsedBytes: 30 * 1024 ** 3,
  diskUsagePercent: 30,
  loadAverage: [0.1, 0.2, 0.3],
  networkReceiveBytes: 8_192,
  networkTransmitBytes: 4_096,
};

describe("server monitor display helpers", () => {
  test("formats byte values and uptime", () => {
    expect(formatMonitorBytes(1536)).toBe("1.5 KB");
    expect(formatMonitorBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatMonitorPercent(49.876)).toBe("50%");
    expect(formatMonitorPercent(Number.NaN)).toBe("0%");
    expect(normalizeMonitorPercent(49.876)).toBe("50%");
    expect(normalizeMonitorPercent("50")).toBe("50%");
    expect(normalizeMonitorPercent("50%")).toBe("50%");
    expect(normalizeMonitorPercent({ value: 50 })).toBeUndefined();
    expect(formatMonitorRate(1536)).toBe("1.5 KB/s");
    expect(formatLatency(5.123)).toBe("5.12 ms");
    expect(formatLatency(15.123)).toBe("15.1 ms");
    expect(formatLatency()).toBe("--");
    expect(formatNetworkEndpoint("0.0.0.0", "22")).toBe("0.0.0.0:22");
    expect(formatNetworkEndpoint("2001:db8::1", "443")).toBe(
      "[2001:db8::1]:443",
    );
    expect(formatUptime(90_000)).toBe("1 天 1 小时");
    expect(formatUptime(7_500)).toBe("2 小时 5 分钟");
  });

  test("keeps a bounded resource history", () => {
    const history = Array.from({ length: 24 }, (_, index) => ({
      collectedAt: index,
      cpuUsagePercent: index,
      memoryUsagePercent: index,
      networkReceiveBytes: index * 1_000,
      networkTransmitBytes: index * 500,
      networkReceiveBytesPerSecond: 1_000,
      networkTransmitBytesPerSecond: 500,
    }));
    const next = appendMonitorHistory(history, snapshot, 100, 24);

    expect(next).toHaveLength(24);
    expect(next[0].collectedAt).toBe(1);
    expect(next[next.length - 1]).toEqual({
      collectedAt: 100,
      cpuUsagePercent: 25,
      memoryUsagePercent: 50,
      networkReceiveBytes: 8_192,
      networkTransmitBytes: 4_096,
      networkReceiveBytesPerSecond: 0,
      networkTransmitBytesPerSecond: 0,
    });
  });

  test("derives network throughput from cumulative counters", () => {
    const first = appendMonitorHistory([], snapshot, 1_000);
    const next = appendMonitorHistory(
      first,
      {
        ...snapshot,
        networkReceiveBytes: 18_432,
        networkTransmitBytes: 9_216,
      },
      3_000,
    );

    expect(next[next.length - 1]?.networkReceiveBytesPerSecond).toBe(5_120);
    expect(next[next.length - 1]?.networkTransmitBytesPerSecond).toBe(2_560);
  });
});
