import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiToolRun } from "../ai-tools";
import AiToolRunList, { aiToolRunDuration } from "./AiToolRunList";

const RUN: AiToolRun = {
  callId: "tool-1",
  durationMs: 1_250,
  label: "读取服务器状态",
  name: "get_server_status",
  startedAt: 1,
  status: "success",
  summary: "CPU：12%",
};

describe("AiToolRunList", () => {
  test("formats tool duration consistently", () => {
    expect(aiToolRunDuration(250)).toBe("250 ms");
    expect(aiToolRunDuration(1_250)).toBe("1.3 秒");
  });

  test("keeps tool actions controlled by the parent", () => {
    const onAddToDraft = mock(() => undefined);
    const onToggle = mock(() => undefined);
    render(
      <AiToolRunList
        expandedRuns={new Set()}
        messageId="message-1"
        onAddToDraft={onAddToDraft}
        onToggle={onToggle}
        runs={[RUN]}
        sending={false}
      />,
    );

    expect(screen.getByText("已完成 · 1.3 秒")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开诊断结果" }));
    fireEvent.click(
      screen.getByRole("button", { name: "将诊断摘要加入下一次提问" }),
    );

    expect(onToggle).toHaveBeenCalledWith("message-1:tool-1:0");
    expect(onAddToDraft).toHaveBeenCalledWith(RUN);
    expect(screen.queryByRole("button", { name: "复制诊断摘要" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新执行诊断工具" })).toBeNull();
  });

  test("shows the bounded summary only when expanded", () => {
    render(
      <AiToolRunList
        expandedRuns={new Set(["message-1:tool-1:0"])}
        messageId="message-1"
        onAddToDraft={() => undefined}
        onToggle={() => undefined}
        runs={[RUN]}
        sending={false}
      />,
    );

    expect(screen.getByText("CPU：12%")).not.toBeNull();
  });
});
