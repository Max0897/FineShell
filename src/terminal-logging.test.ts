import { describe, expect, test } from "bun:test";
import {
  TerminalLogBatcher,
  terminalLogStatusMessage,
  type TerminalLogStartOptions,
  type TerminalLogTransport,
} from "./terminal-logging";

const START_OPTIONS: TerminalLogStartOptions = {
  address: "server.example.com:22",
  directory: "/logs",
  format: "plain",
  hostName: "生产服务器",
  logId: "terminal-log-1",
  maxFileSizeMb: 100,
  sessionId: "session-1",
  startedAt: "2026-08-05T10:00:00.000Z",
  username: "root",
};

function fakeTransport(events: string[]): TerminalLogTransport {
  return {
    async start(options) {
      events.push(`start:${options.sessionId}`);
      return { path: "/logs/session.log" };
    },
    async append(_sessionId, data) {
      events.push(`append:${atob(data)}`);
    },
    async marker(_sessionId, _timestamp, message) {
      events.push(`marker:${message}`);
    },
    async stop(logId) {
      events.push(`stop:${logId}`);
    },
  };
}

describe("terminal log batching", () => {
  test("serializes output, markers, and stop in source order", async () => {
    const events: string[] = [];
    const logger = new TerminalLogBatcher(START_OPTIONS, {
      flushDelayMs: 60_000,
      transport: fakeTransport(events),
    });

    logger.append(new TextEncoder().encode("hello "));
    logger.append(new TextEncoder().encode("world"));
    await logger.marker("2026-08-05T10:00:01.000Z", "连接成功");
    await logger.stop();

    expect(events).toEqual([
      "start:session-1",
      "append:hello world",
      "marker:连接成功",
      "stop:terminal-log-1",
    ]);
  });

  test("flushes immediately when the byte threshold is reached", async () => {
    const events: string[] = [];
    const logger = new TerminalLogBatcher(START_OPTIONS, {
      batchSize: 3,
      flushDelayMs: 60_000,
      transport: fakeTransport(events),
    });

    logger.append(new TextEncoder().encode("abc"));
    await logger.flush();
    await logger.stop();

    expect(events).toContain("append:abc");
  });

  test("reports a transport failure only once", async () => {
    const errors: unknown[] = [];
    const transport = fakeTransport([]);
    transport.start = async () => {
      throw new Error("permission denied");
    };
    const logger = new TerminalLogBatcher(START_OPTIONS, {
      onError: (error) => errors.push(error),
      transport,
    });

    logger.append(new TextEncoder().encode("ignored"));
    await logger.flush();
    await logger.stop();

    expect(errors).toHaveLength(1);
  });

  test("formats connection state markers", () => {
    expect(terminalLogStatusMessage("connected")).toBe("连接成功");
    expect(terminalLogStatusMessage("failed", "连接超时")).toBe(
      "连接失败：连接超时",
    );
  });
});
