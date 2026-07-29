import { describe, expect, test } from "bun:test";
import { buildAiAuditEntries } from "./ai-audit";
import type {
  AgentActionState,
  AgentTask,
  AgentTaskEventPayload,
} from "./tauri-protocol";

function action(overrides: Partial<AgentActionState> = {}): AgentActionState {
  return {
    id: "action-1",
    tool: "propose_file_edit",
    reason: "远程文件修改",
    expectedEffect: "动作效果已脱敏",
    risk: "reversible_write",
    status: "succeeded",
    summary: "动作状态已更新",
    error: null,
    startedAt: 100,
    completedAt: 350,
    durationMs: 250,
    verificationStatus: "verified",
    verificationEvidence: [],
    recoveryState: null,
    ...overrides,
  };
}

function task(actions: AgentActionState[]): AgentTask {
  return {
    id: "task-1",
    conversationId: "conversation-1",
    hostId: "host-1",
    terminalSessionId: "session-1",
    currentDirectory: null,
    approvalMode: "on_request",
    status: "completed",
    objective: "任务内容已脱敏",
    plan: null,
    activeStepId: null,
    actions,
    modelCompleted: true,
    iteration: 1,
    repairAttempts: 0,
    repairLimit: 2,
    repairStopReason: null,
    diagnostics: {
      durationMs: 500,
      modelTurnCount: 1,
      planStepCount: 0,
      actionCount: actions.length,
      verificationEvidenceCount: 0,
      repairAttemptCount: 0,
      stopReason: null,
    },
    lastEventSequence: 2,
    result: null,
    error: null,
    createdAt: 100,
    updatedAt: Date.parse("2026-07-28T09:02:00.000Z"),
  };
}

function event(
  kind: AgentTaskEventPayload["kind"],
  sequence: number,
  currentTask: AgentTask,
  actionId?: string,
): AgentTaskEventPayload {
  return {
    actionId,
    kind,
    protocolVersion: 25,
    sequence,
    task: { ...currentTask, lastEventSequence: sequence },
  };
}

describe("AI operation audit", () => {
  test("builds entries only from redacted runtime events", () => {
    const fileAction = action();
    const commandAction = action({
      id: "action-2",
      tool: "insert_terminal_command",
      reason: "终端命令填入",
      status: "rejected",
      verificationStatus: "pending",
    });
    const events = [
      event("action_succeeded", 1, task([fileAction]), fileAction.id),
      event(
        "action_rejected",
        2,
        task([fileAction, commandAction]),
        commandAction.id,
      ),
    ];

    const entries = buildAiAuditEntries(
      events,
      {},
      new Map([["host-1", "生产服务器"]]),
    );
    expect(entries.map((entry) => entry.category)).toEqual(["command", "file"]);
    expect(entries.map((entry) => entry.status)).toEqual(["rejected", "applied"]);
    expect(entries[0]?.hostName).toBe("生产服务器");
    expect(JSON.stringify(entries)).not.toContain("expectedEffect");
  });

  test("filters runtime events by host and category", () => {
    const currentAction = action();
    const events = [
      event("action_succeeded", 1, task([currentAction]), currentAction.id),
    ];
    expect(
      buildAiAuditEntries(events, { category: "file", hostId: "host-1" }),
    ).toHaveLength(1);
    expect(buildAiAuditEntries(events, { hostId: "missing" })).toEqual([]);
  });
});
