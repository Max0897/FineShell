import { describe, expect, test } from "bun:test";
import {
  agentTaskNeedsRecovery,
  buildAgentRecoveryPrompt,
} from "./ai-task-recovery";
import type { AgentTask, AgentTaskRecoveryContext } from "./tauri-protocol";

const recovery: AgentTaskRecoveryContext = {
  completedActions: ["已读取服务状态"],
  decision: "continue_analysis",
  hostId: "host-1",
  interruptionReason: "应用重启",
  objective: "检查 Nginx",
  previousTaskId: "task-1",
  uncertainActions: ["修改配置"],
};

describe("AI task recovery", () => {
  test("keeps retry safe by requiring new approval for mutations", () => {
    const prompt = buildAgentRecoveryPrompt(recovery, "retry");
    expect(prompt).toContain("原目标：检查 Nginx");
    expect(prompt).toContain("已读取服务状态");
    expect(prompt).toContain("修改配置");
    expect(prompt).toContain("生成全新的动作，并重新请求审批");
  });

  test("only exposes the recovery card for interrupted statuses", () => {
    expect(agentTaskNeedsRecovery({ status: "paused" } as AgentTask)).toBe(true);
    expect(
      agentTaskNeedsRecovery({ status: "paused_disconnected" } as AgentTask),
    ).toBe(true);
    expect(agentTaskNeedsRecovery({ status: "failed" } as AgentTask)).toBe(false);
  });
});
