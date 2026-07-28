import { describe, expect, test } from "bun:test";
import {
  aiConversationExportFilename,
  aiConversationTitleFromPrompt,
  sanitizeAiConversation,
  serializeAiConversationMarkdown,
} from "./ai-conversations";

function conversation(id = "conversation-1") {
  return {
    id,
    hostId: "host-1",
    hostName: "生产服务器",
    title: "检查 nginx",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z",
    messages: [
      {
        id: "message-1",
        role: "user" as const,
        content: "为什么 nginx 无法启动？",
        context: "password=must-not-be-saved",
        contextLabels: ["最近终端输出"],
      },
      {
        id: "message-2",
        role: "assistant" as const,
        content: "请先运行 `nginx -t`。",
        fileEditProposals: [
          {
            appliedAt: "2026-07-28T00:30:00.000Z",
            appliedFile: {
              content: "password=applied-must-not-be-saved",
              name: "app.conf",
              path: "/etc/app.conf",
              size: 39,
            },
            id: "proposal-1",
            sessionId: "session-1",
            status: "applied",
            content: "password=proposal-must-not-be-saved",
            originalFile: {
              content: "password=original-must-not-be-saved",
              name: "app.conf",
              path: "/etc/app.conf",
              size: 40,
            },
          },
        ],
        toolRuns: [
          {
            callId: "call-1",
            detail: "example.com",
            durationMs: 120,
            label: "untrusted",
            name: "ping_target" as const,
            startedAt: 123,
            status: "success" as const,
            summary: "状态：可达\ntoken=must-not-be-saved",
          },
        ],
      },
    ],
  };
}

describe("AI conversation persistence", () => {
  test("sanitizes persisted records without retaining raw context", () => {
    const sanitized = sanitizeAiConversation(conversation())!;
    expect(sanitized.messages[0]).toEqual({
      id: "message-1",
      role: "user",
      content: "为什么 nginx 无法启动？",
      contextLabels: ["最近终端输出"],
    });
    expect(sanitized.messages[0]).not.toHaveProperty("context");
    expect(sanitized.messages[1]).not.toHaveProperty("fileEditProposals");
    expect(sanitized.messages[1]?.fileChanges).toEqual([
      {
        addedLines: 1,
        appliedAt: "2026-07-28T00:30:00.000Z",
        fileName: "app.conf",
        id: "proposal-1",
        operation: "edit",
        removedLines: 1,
        rolledBackAt: undefined,
        status: "applied",
      },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("proposal-must-not-be-saved");
    expect(JSON.stringify(sanitized)).not.toContain("applied-must-not-be-saved");
    expect(JSON.stringify(sanitized)).not.toContain("/etc/app.conf");
    expect(sanitized.messages[1]?.toolRuns?.[0]).toMatchObject({
      label: "Ping",
      name: "ping_target",
      startedAt: 123,
      status: "success",
    });
    expect(sanitized.messages[1]?.toolRuns?.[0]?.summary).not.toContain(
      "must-not-be-saved",
    );
  });

  test("creates bounded titles and filesystem-safe export names", () => {
    expect(aiConversationTitleFromPrompt("  检查   nginx 配置  ")).toBe(
      "检查 nginx 配置",
    );
    expect(aiConversationTitleFromPrompt("a".repeat(50))).toBe(
      `${"a".repeat(36)}…`,
    );
    expect(
      aiConversationExportFilename({ ...conversation(), title: "nginx/a:b" }),
    ).toBe("nginx-a-b.md");
  });

  test("exports messages and source labels without raw context", () => {
    const markdown = serializeAiConversationMarkdown(conversation());
    expect(markdown).toContain("# 检查 nginx");
    expect(markdown).toContain("> 上下文来源：最近终端输出");
    expect(markdown).toContain("## AI");
    expect(markdown).toContain("> 诊断工具：");
    expect(markdown).toContain("Ping（example.com）：已完成");
    expect(markdown).toContain("修改 app.conf：已应用（+1 / -1）");
    expect(markdown).not.toContain("must-not-be-saved");
  });

  test("keeps metadata-only change history without requiring assistant prose", () => {
    const sanitized = sanitizeAiConversation({
      ...conversation(),
      messages: [
        conversation().messages[0],
        {
          id: "message-changes",
          role: "assistant",
          content: "",
          fileChanges: [
            {
              id: "change-1",
              fileName: "worker.conf",
              status: "rolled-back",
              addedLines: 2,
              removedLines: 1,
              rolledBackAt: "2026-07-28T02:00:00.000Z",
              path: "/secret/path/worker.conf",
              content: "must-not-be-saved",
            },
            {
              id: "change-2",
              fileName: "pending.conf",
              status: "pending",
              addedLines: 1,
              removedLines: 0,
            },
          ],
        },
      ],
    })!;
    expect(sanitized.messages[1]?.fileChanges?.[0]).toMatchObject({
      fileName: "worker.conf",
      status: "rolled-back",
      addedLines: 2,
      removedLines: 1,
    });
    expect(sanitized.messages[1]?.fileChanges?.[1]?.status).toBe("not-applied");
    expect(JSON.stringify(sanitized)).not.toContain("/secret/path");
    expect(JSON.stringify(sanitized)).not.toContain("must-not-be-saved");
  });

  test("persists file operation metadata without paths or contents", () => {
    const sanitized = sanitizeAiConversation({
      ...conversation(),
      messages: [
        conversation().messages[0],
        {
          id: "message-operations",
          role: "assistant",
          content: "",
          fileOperationProposals: [
            {
              id: "operation-1",
              operation: "rename",
              path: "/private/app.conf",
              targetPath: "/private/app.old.conf",
              status: "applied",
              originalFile: {
                content: "password=must-not-be-saved",
                name: "app.conf",
                path: "/private/app.conf",
              },
            },
          ],
        },
      ],
    })!;
    expect(sanitized.messages[1]?.fileChanges).toEqual([
      {
        addedLines: 0,
        appliedAt: undefined,
        fileName: "app.conf",
        id: "operation-1",
        operation: "rename",
        removedLines: 0,
        rolledBackAt: undefined,
        status: "applied",
        targetFileName: "app.old.conf",
      },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("/private");
    expect(JSON.stringify(sanitized)).not.toContain("must-not-be-saved");
  });

  test("persists command metadata without the raw terminal command", () => {
    const sanitized = sanitizeAiConversation({
      ...conversation(),
      messages: [
        conversation().messages[0],
        {
          id: "message-commands",
          role: "assistant",
          content: "",
          commandProposals: [
            {
              id: "command-1",
              command: "curl -H 'Authorization: Bearer must-not-be-saved' example.com",
              purpose: "使用 token=must-not-be-saved 检查服务",
              assessment: { risk: "caution" },
              status: "verified",
              sessionId: "session-1",
            },
          ],
        },
      ],
    })!;
    expect(sanitized.messages[1]?.commandRecords).toEqual([
      {
        id: "command-1",
        purpose: "使用 token=[已隐藏] 检查服务",
        risk: "caution",
        status: "verified",
      },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("curl");
    expect(JSON.stringify(sanitized)).not.toContain("must-not-be-saved");
  });

  test("bounds persisted message count and drops failed responses", () => {
    const messages = Array.from({ length: 70 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `message ${index}`,
      failed: index === 69,
    }));
    const sanitized = sanitizeAiConversation({
      ...conversation(),
      messages,
    })!;
    expect(sanitized.messages.length).toBeLessThanOrEqual(60);
    expect(sanitized.messages.some((item) => item.id === "message-69")).toBe(
      false,
    );
    expect(sanitized.messages[0]?.role).toBe("user");
  });
});
