import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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
) {
  return {
    onCancel,
    onConfirm,
    onStop,
    ...render(
      <AiDiagnosticPlanList
        expandedRuns={new Set()}
        messageId="message-1"
        onAddToDraft={() => undefined}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onCopy={() => undefined}
        onRerun={() => undefined}
        onStop={onStop}
        onToggleRun={() => undefined}
        plans={[currentPlan]}
        runs={runs}
        sending
        sessionAvailable
      />,
    ),
  };
}

describe("AiDiagnosticPlanList", () => {
  test("shows active probe targets and confirms only selected optional steps", () => {
    const view = renderPlans();
    expect(screen.getByText("example.com")).not.toBeNull();
    expect(screen.getByText("主动探测")).not.toBeNull();
    expect(screen.getByText("确认目标是否可达")).not.toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "执行可选步骤：Ping" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));

    expect(view.onConfirm).toHaveBeenCalledWith("plan-1", ["call-status"]);
  });

  test("cancels a pending plan", () => {
    const view = renderPlans();
    fireEvent.click(screen.getByRole("button", { name: "取消计划" }));
    expect(view.onCancel).toHaveBeenCalledWith("plan-1");
  });

  test("stops remaining steps while a plan is running", () => {
    const view = renderPlans({ ...plan, status: "running" });
    fireEvent.click(screen.getByRole("button", { name: "停止剩余步骤" }));
    expect(view.onStop).toHaveBeenCalledWith("plan-1");
  });
});
