import { describe, expect, test } from "bun:test";
import {
  aiToolCallFromRun,
  aiToolLabel,
  aiToolResult,
  aiToolResultSummary,
  aiToolRequiresConfirmation,
  aiToolTarget,
  createAiToolRun,
  currentDirectoryToolValue,
  finishAiToolRun,
  isAiReadOnlyToolName,
  networkConnectionsToolValue,
  pingToolValue,
  processListToolValue,
  serverStatusToolValue,
  sanitizePersistedAiToolRuns,
  traceRouteToolValue,
} from "./ai-tools";

describe("AI read-only tools", () => {
  test("accepts only the fixed read-only allowlist", () => {
    expect(isAiReadOnlyToolName("get_server_status")).toBe(true);
    expect(isAiReadOnlyToolName("list_processes")).toBe(true);
    expect(isAiReadOnlyToolName("ping_target")).toBe(true);
    expect(isAiReadOnlyToolName("trace_route")).toBe(true);
    expect(isAiReadOnlyToolName("run_shell_command")).toBe(false);
    expect(aiToolLabel("run_shell_command")).toBe("未知只读工具");
    expect(aiToolRequiresConfirmation("ping_target")).toBe(true);
    expect(aiToolRequiresConfirmation("get_server_status")).toBe(false);
  });

  test("validates network targets before executing diagnostic tools", () => {
    expect(
      aiToolTarget({
        id: "call-1",
        name: "ping_target",
        arguments: '{"target":"example.com"}',
      }),
    ).toBe("example.com");
    expect(() =>
      aiToolTarget({
        id: "call-2",
        name: "trace_route",
        arguments: '{"target":"example.com; reboot"}',
      }),
    ).toThrow("网络诊断目标格式无效");
  });

  test("records the target, duration, and final status of a tool run", () => {
    const running = createAiToolRun(
      {
        id: "call-1",
        name: "ping_target",
        arguments: '{"target":"1.1.1.1"}',
      },
      1_000,
    );
    expect(running.detail).toBe("1.1.1.1");
    const completed = finishAiToolRun(
      running,
      { summary: "状态：可达" },
      1_250,
    );
    expect(completed).toMatchObject({
      durationMs: 250,
      status: "success",
      summary: "状态：可达",
    });
    expect(aiToolCallFromRun(completed).arguments).toBe(
      '{"target":"1.1.1.1"}',
    );
  });

  test("serializes a bounded server status snapshot", () => {
    const value = serverStatusToolValue({
      hostname: "server",
      operatingSystem: "Linux",
      kernel: "6.8",
      uptimeSeconds: 120,
      cpuUsagePercent: 10,
      memoryTotalBytes: 1_000,
      memoryUsedBytes: 400,
      memoryUsagePercent: 40,
      diskTotalBytes: 2_000,
      diskUsedBytes: 500,
      diskUsagePercent: 25,
      loadAverage: [0.1, 0.2, 0.3],
      networkReceiveBytes: 100,
      networkTransmitBytes: 200,
    });
    expect(value).toMatchObject({
      ok: true,
      hostname: "server",
      memory: { usagePercent: 40 },
      disk: { usagePercent: 25 },
    });
  });

  test("sorts and bounds process results before sending them to a model", () => {
    const value = processListToolValue(
      {
        truncated: false,
        processes: [
          {
            id: "1",
            pid: 1,
            parentPid: 0,
            user: "root",
            state: "S",
            cpuUsagePercent: 1,
            memoryUsagePercent: 2,
            residentMemoryBytes: 100,
            elapsedSeconds: 20,
            name: "init",
            command: "init",
          },
          {
            id: "2",
            pid: 2,
            parentPid: 1,
            user: "app",
            state: "R",
            cpuUsagePercent: 90,
            memoryUsagePercent: 10,
            residentMemoryBytes: 200,
            elapsedSeconds: 10,
            name: "worker",
            command: "worker --serve",
          },
        ],
      },
      1,
    );
    expect(value.processes.map((process) => process.pid)).toEqual([2]);
    expect(value.truncated).toBe(true);
  });

  test("reports an unavailable SFTP directory without guessing", () => {
    expect(currentDirectoryToolValue("/srv/app")).toEqual({
      ok: true,
      path: "/srv/app",
    });
    expect(currentDirectoryToolValue(" ")).toEqual({
      ok: false,
      error: "SFTP 当前目录尚不可用",
    });
  });

  test("bounds network diagnostic results before sending them to a model", () => {
    const connections = networkConnectionsToolValue(
      {
        connections: Array.from({ length: 60 }, (_, index) => ({
          id: String(index),
          protocol: "tcp",
          state: "ESTAB",
          localAddress: "127.0.0.1",
          localPort: String(8_000 + index),
          remoteAddress: "10.0.0.1",
          remotePort: "443",
          process: "worker",
        })),
        truncated: false,
      },
      40,
    );
    expect(connections.returned).toBe(40);
    expect(connections.truncated).toBe(true);

    expect(
      pingToolValue({
        target: "example.com",
        reachable: true,
        transmitted: 3,
        received: 3,
        packetLossPercent: 0,
        averageLatencyMs: 12,
      }),
    ).toMatchObject({ ok: true, target: "example.com", averageLatencyMs: 12 });

    expect(
      traceRouteToolValue({
        target: "example.com",
        reached: true,
        hops: Array.from({ length: 20 }, (_, index) => ({ hop: index + 1 })),
      }).hops,
    ).toHaveLength(12);
  });

  test("creates compact summaries without persisting raw network endpoints", () => {
    const call = {
      id: "call-1",
      name: "get_network_connections",
      arguments: "{}",
    };
    const result = aiToolResult(call, {
      ok: true,
      total: 2,
      returned: 2,
      connections: [
        { state: "ESTAB", remoteAddress: "sensitive.internal" },
        { state: "LISTEN", localAddress: "0.0.0.0" },
      ],
    });
    const summary = aiToolResultSummary(call, result);
    expect(summary).toContain("连接总数：2");
    expect(summary).toContain("ESTAB 1");
    expect(summary).not.toContain("sensitive.internal");
  });

  test("sanitizes and bounds persisted tool summaries", () => {
    const runs = sanitizePersistedAiToolRuns([
      {
        callId: "call-1",
        detail: "example.com",
        durationMs: 120,
        label: "untrusted label",
        name: "ping_target",
        startedAt: 123,
        status: "success",
        summary: "token=secret-value",
      },
      {
        callId: "call-2",
        name: "run_shell_command",
        status: "success",
      },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({
      label: "Ping",
      name: "ping_target",
      startedAt: 123,
      status: "success",
    });
    expect(runs?.[0]?.summary).toContain("[已隐藏]");
  });

  test("redacts credentials before returning tool data", () => {
    const result = aiToolResult(
      { id: "call-1", name: "list_processes", arguments: "{}" },
      { command: "worker --password process-secret" },
    );
    expect(result.content).not.toContain("process-secret");
    expect(result.content).toContain("[已隐藏]");
  });
});
