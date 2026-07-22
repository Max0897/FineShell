import { describe, expect, test } from "bun:test";
import type { ServerMonitorSnapshot } from "./models";
import {
  appendMonitorHistory,
  formatMonitorBytes,
  formatUptime,
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
};

describe("server monitor display helpers", () => {
  test("formats byte values and uptime", () => {
    expect(formatMonitorBytes(1536)).toBe("1.5 KB");
    expect(formatMonitorBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatUptime(90_000)).toBe("1 天 1 小时");
    expect(formatUptime(7_500)).toBe("2 小时 5 分钟");
  });

  test("keeps a bounded resource history", () => {
    const history = Array.from({ length: 24 }, (_, index) => ({
      collectedAt: index,
      cpuUsagePercent: index,
      memoryUsagePercent: index,
    }));
    const next = appendMonitorHistory(history, snapshot, 100, 24);

    expect(next).toHaveLength(24);
    expect(next[0].collectedAt).toBe(1);
    expect(next[next.length - 1]).toEqual({
      collectedAt: 100,
      cpuUsagePercent: 25,
      memoryUsagePercent: 50,
    });
  });
});
