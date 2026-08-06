import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import AiAssistantHeader from "./AiAssistantHeader";

describe("AiAssistantHeader", () => {
  test("keeps conversation creation and history without delete or close actions", () => {
    render(
      <AiAssistantHeader
        conversationSummarized={false}
        conversationSummarizing={false}
        conversationTitle="诊断会话"
        onNew={mock(() => undefined)}
        onOpenHistory={mock(() => undefined)}
        sending={false}
        sessionAvailable
      />,
    );

    expect(screen.getByRole("button", { name: "新建对话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "对话历史" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "AI 审批模式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除当前对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭 AI 助手" })).toBeNull();
  });
});
