import { describe, expect, test } from "bun:test";
import type { ServerProcess } from "./models";
import {
  filterServerProcesses,
  formatProcessElapsed,
  formatProcessPercent,
} from "./process-utils";

const processes: ServerProcess[] = [
  {
    id: "process-10",
    pid: 10,
    parentPid: 1,
    user: "root",
    state: "Ssl",
    cpuUsagePercent: 12.5,
    memoryUsagePercent: 3.2,
    residentMemoryBytes: 1024,
    elapsedSeconds: 90,
    name: "node",
    command: "node /opt/app/server.js",
  },
  {
    id: "process-20",
    pid: 20,
    parentPid: 10,
    user: "deploy",
    state: "S",
    cpuUsagePercent: 0.2,
    memoryUsagePercent: 1.1,
    residentMemoryBytes: 2048,
    elapsedSeconds: 30,
    name: "worker",
    command: "worker --queue critical",
  },
];

describe("process display helpers", () => {
  test("filters by process metadata", () => {
    expect(filterServerProcesses(processes, "NODE")).toEqual([processes[0]]);
    expect(filterServerProcesses(processes, "deploy")).toEqual([processes[1]]);
    expect(filterServerProcesses(processes, "10")).toEqual(processes);
    expect(filterServerProcesses(processes, "  ")).toEqual(processes);
  });

  test("formats process resource and elapsed values", () => {
    expect(formatProcessPercent(0.24)).toBe("0.2%");
    expect(formatProcessPercent(125.45)).toBe("125.5%");
    expect(formatProcessElapsed(45)).toBe("45 秒");
    expect(formatProcessElapsed(125)).toBe("2 分 5 秒");
    expect(formatProcessElapsed(90_000)).toBe("1 天 1 小时");
  });
});
