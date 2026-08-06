import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AiDiagnosticPlan } from "../ai-diagnostic-plans";
import type { AiToolRun } from "../ai-tools";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";

const plan: AiDiagnosticPlan = {
  createdAt: "2026-07-28T10:00:00.000Z",
  description: "检查服务器并确认目标网络。",
  id: "plan-1",
  status: "pending",
  stepCallIds: ["call-status", "call-ping"],
};

const runs: AiToolRun[] = [
  {
    callId: "call-status",
    label: "读取服务器状态",
    name: "get_server_status",
    planId: "plan-1",
    reason: "确认资源使用情况",
    startedAt: 1_000,
    status: "pending",
  },
  {
    callId: "call-ping",
    detail: "example.com",
    label: "Ping",
    name: "ping_target",
    optional: true,
    planId: "plan-1",
    reason: "确认目标是否可达",
    startedAt: 1_000,
    status: "pending",
  },
];

function renderPlans(
  currentPlan = plan,
  onConfirm = mock(() => undefined),
  onCancel = mock(() => undefined),
  onStop = mock(() => undefined),
  onRevise = mock(() => undefined),
) {
  return {
    onCancel,
    onConfirm,
    onStop,
    onRevise,
    ...render(
      <AiDiagnosticPlanList
        expandedRuns={new Set()}
        messageId="message-1"
        onAddToDraft={() => undefined}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRevise={onRevise}
        onStop={onStop}
        onToggleRun={() => undefined}
        plans={[currentPlan]}
        presentation={currentPlan.status === "pending" ? "approval" : "timeline"}
        runs={runs}
        sending
      />,
    ),
  };
}

describe("AiDiagnosticPlanList", () => {
  test("shows the whole active probe request as one approval", async () => {
    const view = renderPlans();
    expect(screen.getByText("example.com")).not.toBeNull();
    expect(screen.getByText("主动探测")).not.toBeNull();
    expect(screen.getByText("确认目标是否可达")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "同意" }));
      await Promise.resolve();
    });

    expect(view.onConfirm).toHaveBeenCalledWith("plan-1", [
      "call-status",
      "call-ping",
    ]);
  });

  test("cancels a pending plan", async () => {
    const view = renderPlans();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
      await Promise.resolve();
    });
    expect(view.onCancel).toHaveBeenCalledWith("plan-1");
  });

  test("returns other instructions through the approval", async () => {
    const view = renderPlans();
    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.change(
      screen.getByPlaceholderText(
        "输入其他处理要求，例如：不要探测公网，只读取本机连接",
      ),
      { target: { value: "只读取本机连接" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
      await Promise.resolve();
    });

    expect(view.onRevise).toHaveBeenCalledWith("plan-1", "只读取本机连接");
  });

  test("stops remaining steps while a plan is running", () => {
    const view = renderPlans({ ...plan, status: "running" });
    fireEvent.click(screen.getByRole("button", { name: "停止剩余步骤" }));
    expect(view.onStop).toHaveBeenCalledWith("plan-1");
  });
});
