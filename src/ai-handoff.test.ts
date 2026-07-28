import { describe, expect, test } from "bun:test";
import {
  createNetworkAiHandoff,
  createProcessesAiHandoff,
  createSftpSelectionAiHandoff,
} from "./ai-handoff";

describe("AI 业务上下文交接", () => {
  test("进程上下文最多保留 20 项", () => {
    const request = createProcessesAiHandoff(
      Array.from({ length: 25 }, (_, index) => ({
        id: String(index),
        pid: index + 1,
        parentPid: 1,
        user: "root",
        state: "S",
        cpuUsagePercent: index,
        memoryUsagePercent: 1,
        residentMemoryBytes: 1024,
        elapsedSeconds: 10,
        name: `process-${index}`,
        command: `process-${index}`,
      })),
    );

    const payload = JSON.parse(request.source.content);
    expect(payload.selected).toHaveLength(20);
    expect(payload.omitted).toBe(5);
  });

  test("网络上下文不发送超过 30 条连接", () => {
    const request = createNetworkAiHandoff({
      ping: null,
      trace: null,
      connections: {
        truncated: false,
        connections: Array.from({ length: 35 }, (_, index) => ({
          id: String(index),
          protocol: "tcp",
          state: "ESTAB",
          localAddress: "127.0.0.1",
          localPort: String(index),
          remoteAddress: "127.0.0.1",
          remotePort: "443",
        })),
      },
    });

    const payload = JSON.parse(request.source.content);
    expect(payload.connections).toHaveLength(30);
    expect(payload.connectionsOmitted).toBe(5);
  });

  test("SFTP 上下文只包含元数据", () => {
    const request = createSftpSelectionAiHandoff("/root", [
      {
        id: "1",
        name: "config.json",
        path: "/root/config.json",
        kind: "file",
        size: 12,
        owner: "root",
        group: "root",
      },
    ]);

    expect(request.source.content).toContain("/root/config.json");
    expect(request.source.content).not.toContain("content");
  });
});
