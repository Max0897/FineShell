import { describe, expect, test } from "bun:test";
import { buildAiAuditEntries } from "./ai-audit";
import type { AiConversationRecord } from "./ai-conversations";

const conversations: AiConversationRecord[] = [
  {
    createdAt: "2026-07-28T08:00:00.000Z",
    hostId: "host-1",
    hostName: "生产服务器",
    id: "conversation-1",
    messages: [
      {
        content: "完成",
        id: "message-1",
        role: "assistant",
        toolRuns: [
          {
            callId: "tool-1",
            detail: "private.example.com",
            durationMs: 250,
            label: "读取服务器状态",
            name: "get_server_status",
            planId: "plan-1",
            startedAt: Date.parse("2026-07-28T09:00:00.000Z"),
            status: "success",
            summary: "password=secret",
          },
        ],
        commandRecords: [
          {
            id: "command-1",
            occurredAt: "2026-07-28T09:01:00.000Z",
            purpose: "查看 nginx 状态",
            risk: "safe",
            status: "executed",
          },
        ],
        fileChanges: [
          {
            addedLines: 1,
            appliedAt: "2026-07-28T09:02:00.000Z",
            fileName: "nginx.conf",
            id: "file-1",
            operation: "edit",
            removedLines: 1,
            status: "applied",
          },
        ],
      },
    ],
    title: "排查服务",
    updatedAt: "2026-07-28T09:02:00.000Z",
  },
];

describe("AI operation audit", () => {
  test("builds a unified time-ordered view without raw sensitive payloads", () => {
    const entries = buildAiAuditEntries(conversations);
    expect(entries.map((entry) => entry.category)).toEqual([
      "file",
      "command",
      "diagnostic",
    ]);
    const serialized = JSON.stringify(entries);
    expect(entries.find((entry) => entry.category === "diagnostic")?.planId).toBe(
      "plan-1",
    );
    expect(serialized).not.toContain("private.example.com");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
  });

  test("filters by host and category", () => {
    expect(
      buildAiAuditEntries(conversations, {
        category: "command",
        hostId: "host-1",
      }),
    ).toHaveLength(1);
    expect(
      buildAiAuditEntries(conversations, { hostId: "missing" }),
    ).toEqual([]);
  });
});
