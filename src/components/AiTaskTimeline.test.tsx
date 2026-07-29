import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentTask } from "../tauri-protocol";
import AiTaskTimeline from "./AiTaskTimeline";

function task(): AgentTask {
  return {
    id: "task-1",
    conversationId: "conversation-1",
    hostId: "host-1",
    terminalSessionId: "session-1",
    currentDirectory: "/srv/app",
    approvalMode: "on_request",
    status: "awaiting_approval",
    objective: "修复 Nginx 配置",
    plan: {
      id: "plan-1",
      description: "检查并修复服务",
      status: "running",
      createdAt: 1,
      steps: [{
        id: "step-1",
        title: "检查 Nginx",
        tool: "get_server_status",
        status: "completed",
        detail: null,
        reason: "确认服务状态",
        optional: false,
        dependsOn: [],
        summary: "检查完成",
        error: null,
        startedAt: 1,
        durationMs: 20,
      }],
    },
    activeStepId: null,
    actions: [{
      id: "action-1",
      tool: "insert_terminal_command",
      reason: "重启 Nginx",
      expectedEffect: "将命令填入终端",
      risk: "elevated",
      status: "pending",
      summary: null,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      verificationStatus: "failed",
      verificationEvidence: [{
        kind: "service_status",
        summary: "服务未运行",
        observedAt: 2,
      }],
      recoveryState: {
        recommendation: "retry",
        status: "suggested",
        summary: "建议修正动作参数后重试",
        updatedAt: 2,
      },
    }],
    modelCompleted: true,
    iteration: 1,
    repairAttempts: 1,
    repairLimit: 2,
    repairStopReason: "verification_failed",
    diagnostics: {
      actionCount: 1,
      durationMs: 1_250,
      modelTurnCount: 2,
      planStepCount: 1,
      repairAttemptCount: 1,
      stopReason: "verification_failed",
      verificationEvidenceCount: 1,
    },
    lastEventSequence: 4,
    result: null,
    error: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("AiTaskTimeline", () => {
  test("combines plan, approval, artifact, verification, and recovery state", () => {
    render(<AiTaskTimeline task={task()} />);

    expect(screen.getByText("检查 Nginx")).not.toBeNull();
    expect(screen.getByText("填入终端 · 重启 Nginx")).not.toBeNull();
    expect(screen.getByText("等待审阅")).not.toBeNull();
    expect(screen.getByText("验证失败")).not.toBeNull();
    expect(screen.getByText(/服务未运行/)).not.toBeNull();
    expect(screen.getByText("已修复 1 / 2 次")).not.toBeNull();
    expect(screen.getByText("2 轮 · 1 个动作 · 1 条验证 · 1.3 秒")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起任务时间线" }));
    expect(screen.queryByText("检查 Nginx")).toBeNull();
    expect(screen.getByRole("button", { name: "展开任务时间线" })).not.toBeNull();
  });
});
