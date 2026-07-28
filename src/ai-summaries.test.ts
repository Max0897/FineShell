import { describe, expect, test } from "bun:test";
import type { AiConversationRecord } from "./ai-conversations";
import {
  AI_SUMMARY_RECENT_MESSAGES,
  buildAiConversationRequestMessages,
  completeAiConversationSummary,
  createAiConversationSummaryPlan,
  messagesAfterAiSummary,
} from "./ai-summaries";

function conversation(messageCount: number): AiConversationRecord {
  return {
    createdAt: "2026-07-28T00:00:00.000Z",
    hostId: "host-1",
    hostName: "测试主机",
    id: "conversation-1",
    messages: Array.from({ length: messageCount }, (_, index) => ({
      content: `第 ${index + 1} 条消息`,
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    })),
    title: "测试对话",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("AI conversation summaries", () => {
  test("does not summarize short conversations", () => {
    expect(createAiConversationSummaryPlan(conversation(8))).toBeUndefined();
  });

  test("summarizes older complete turns and protects recent messages", () => {
    const source = conversation(18);
    const plan = createAiConversationSummaryPlan(source)!;
    const throughIndex = source.messages.findIndex(
      (message) => message.id === plan.throughMessageId,
    );

    expect(plan.throughMessageId).toBe("message-10");
    expect(source.messages.length - throughIndex - 1).toBe(
      AI_SUMMARY_RECENT_MESSAGES,
    );
    expect(plan.prompt).toContain("第 1 条消息");
    expect(plan.prompt).not.toContain("第 11 条消息");
  });

  test("advances an existing summary without resummarizing its messages", () => {
    const source = conversation(22);
    source.summary = {
      content: "此前已经确认服务运行在测试环境。",
      throughMessageId: "message-4",
      updatedAt: "2026-07-28T01:00:00.000Z",
    };
    const plan = createAiConversationSummaryPlan(source)!;

    expect(plan.prompt).toContain("此前已经确认服务运行在测试环境");
    expect(plan.prompt).not.toContain("第 4 条消息");
    expect(plan.prompt).toContain("第 5 条消息");
    expect(plan.throughMessageId).toBe("message-14");
  });

  test("uses the summary plus only messages after its watermark", () => {
    const source = conversation(12);
    const summary = {
      content: "较早对话摘要",
      throughMessageId: "message-4",
      updatedAt: "2026-07-28T01:00:00.000Z",
    };
    const messages = buildAiConversationRequestMessages(source.messages, summary);

    expect(messages[0]?.content).toContain("较早对话摘要");
    expect(messages.some((message) => message.content === "第 4 条消息")).toBe(
      false,
    );
    expect(messages.some((message) => message.content === "第 5 条消息")).toBe(
      true,
    );
    expect(messagesAfterAiSummary(source.messages, summary)).toHaveLength(8);
  });

  test("redacts and bounds model-generated summaries", () => {
    const plan = createAiConversationSummaryPlan(conversation(18))!;
    const completed = completeAiConversationSummary(
      plan,
      `结论\npassword=secret-value\n${"x".repeat(5_000)}`,
      "2026-07-28T02:00:00.000Z",
    );

    expect(completed.content).toContain("password=[已隐藏]");
    expect(completed.content).not.toContain("secret-value");
    expect(completed.content.length).toBeLessThanOrEqual(4_000);
    expect(completed.throughMessageId).toBe(plan.throughMessageId);
  });
});
