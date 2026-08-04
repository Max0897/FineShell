import { describe, expect, test } from "bun:test";
import type { TerminalCommandHistoryRecord } from "./models";
import {
  applyTerminalCommandHistoryPolicy,
  findTerminalHistoryCompletion,
  MAX_TERMINAL_COMMAND_HISTORY_PER_HOST,
  recordTerminalCommand,
  sanitizeTerminalCommandHistoryRecord,
} from "./terminal-command-history";

function historyRecord(
  overrides: Partial<TerminalCommandHistoryRecord> = {},
): TerminalCommandHistoryRecord {
  return {
    id: "history-1",
    hostId: "host-1",
    command: "git status",
    cwd: "/srv/app",
    lastUsedAt: "2026-08-04T00:00:00.000Z",
    useCount: 1,
    ...overrides,
  };
}

describe("terminal command history policy", () => {
  test("records repeated commands once and updates usage metadata", () => {
    const first = recordTerminalCommand(
      [],
      { hostId: "host-1", command: "git status", cwd: "/srv/app" },
      new Date("2026-08-04T00:00:00.000Z"),
    );
    const second = recordTerminalCommand(
      first,
      { hostId: "host-1", command: "git status", cwd: "/srv/api" },
      new Date("2026-08-04T01:00:00.000Z"),
    );

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      hostId: "host-1",
      command: "git status",
      cwd: "/srv/api",
      lastUsedAt: "2026-08-04T01:00:00.000Z",
      useCount: 2,
    });
  });

  test("rejects terminal controls and malformed persisted records", () => {
    expect(
      sanitizeTerminalCommandHistoryRecord(
        historyRecord({ command: "echo ok\nrm -rf /" }),
      ),
    ).toBeUndefined();
    expect(
      recordTerminalCommand(
        [],
        { hostId: "host-1", command: "echo ok\u001b[A" },
        new Date("2026-08-04T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  test("keeps only the newest entries within each host limit", () => {
    const records = Array.from(
      { length: MAX_TERMINAL_COMMAND_HISTORY_PER_HOST + 2 },
      (_, index) =>
        historyRecord({
          id: `history-${index}`,
          command: `echo ${index}`,
          lastUsedAt: new Date(index).toISOString(),
        }),
    );

    const limited = applyTerminalCommandHistoryPolicy(records);
    expect(limited).toHaveLength(MAX_TERMINAL_COMMAND_HISTORY_PER_HOST);
    expect(limited[0].command).toBe(
      `echo ${MAX_TERMINAL_COMMAND_HISTORY_PER_HOST + 1}`,
    );
    expect(limited[limited.length - 1]?.command).toBe("echo 2");
  });
});

describe("terminal history completion", () => {
  test("prefers the current directory before global usage count", () => {
    const completion = findTerminalHistoryCompletion(
      [
        historyRecord({
          id: "global",
          command: "git status --short",
          cwd: "/srv/other",
          useCount: 20,
        }),
        historyRecord({
          id: "local",
          command: "git status --branch",
          cwd: "/srv/app",
          useCount: 1,
        }),
      ],
      { hostId: "host-1", commandLine: "git st", cwd: "/srv/app" },
    );

    expect(completion).toEqual({
      command: "git status --branch",
      suffix: "atus --branch",
    });
  });

  test("requires two characters and never suggests an exact command", () => {
    const records = [historyRecord()];
    expect(
      findTerminalHistoryCompletion(records, {
        hostId: "host-1",
        commandLine: "g",
      }),
    ).toBeUndefined();
    expect(
      findTerminalHistoryCompletion(records, {
        hostId: "host-1",
        commandLine: "git status",
      }),
    ).toBeUndefined();
  });

  test("does not expose history from another host", () => {
    expect(
      findTerminalHistoryCompletion([historyRecord()], {
        hostId: "host-2",
        commandLine: "git st",
      }),
    ).toBeUndefined();
  });
});
