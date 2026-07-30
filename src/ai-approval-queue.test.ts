import { describe, expect, test } from "bun:test";
import {
  aiApprovalRequiresUserDecision,
  buildAiApprovalQueue,
  type AiApprovalQueueItem,
} from "./ai-approval-queue";
import type { AiCommandProposal } from "./ai-command-proposals";

function command(
  id: string,
  status: AiCommandProposal["status"],
): AiCommandProposal {
  return {
    assessment: { canInsert: true, label: "低风险", risk: "safe" },
    command: "uname -a",
    id,
    purpose: "查看系统信息",
    sessionId: "session-1",
    status,
  };
}

describe("AI approval queue", () => {
  test("matches automatic action handling to the selected approval mode", () => {
    const commandItem: AiApprovalQueueItem = {
      kind: "command",
      messageId: "message-1",
      proposal: command("command-1", "pending"),
    };
    const editItem: AiApprovalQueueItem = {
      kind: "file-edit",
      messageId: "message-1",
      proposal: {
        content: "next",
        id: "edit-1",
        originalFile: {
          content: "before",
          name: "app.conf",
          path: "/etc/app.conf",
          size: 6,
        },
        sessionId: "session-1",
        status: "pending",
      },
    };
    const deleteItem: AiApprovalQueueItem = {
      kind: "file-operation",
      messageId: "message-1",
      proposal: {
        id: "delete-1",
        operation: "delete",
        originalFile: {
          content: "before",
          name: "app.conf",
          path: "/etc/app.conf",
          size: 6,
        },
        path: "/etc/app.conf",
        sessionId: "session-1",
        status: "pending",
      },
    };

    expect(aiApprovalRequiresUserDecision(commandItem, "on_request")).toBe(
      true,
    );
    expect(aiApprovalRequiresUserDecision(commandItem, "auto_safe")).toBe(
      false,
    );
    expect(aiApprovalRequiresUserDecision(editItem, "auto_safe")).toBe(true);
    expect(aiApprovalRequiresUserDecision(deleteItem, "auto_safe")).toBe(true);
    expect(
      aiApprovalRequiresUserDecision(
        {
          ...commandItem,
          proposal: {
            ...commandItem.proposal,
            assessment: {
              label: "需确认",
              risk: "caution",
              reason: "会修改服务状态",
              canInsert: true,
            },
          },
        },
        "auto_safe",
      ),
    ).toBe(true);
    expect(aiApprovalRequiresUserDecision(commandItem, "full_access")).toBe(
      false,
    );
    expect(aiApprovalRequiresUserDecision(deleteItem, "full_access")).toBe(
      false,
    );
  });

  test("combines pending diagnostics and blocking commands for the active task", () => {
    const queue = buildAiApprovalQueue(
      [
        {
          commandProposals: [
            command("command-pending", "pending"),
            command("command-finished", "succeeded"),
          ],
          diagnosticPlans: [
            {
              createdAt: "2026-07-30T08:00:00.000Z",
              id: "plan-1",
              status: "pending",
              stepCallIds: ["call-1"],
            },
          ],
          id: "message-1",
          taskId: "task-1",
          toolRuns: [
            {
              callId: "call-1",
              label: "Ping",
              name: "ping_target",
              planId: "plan-1",
              reason: "检查网络",
              startedAt: 1,
              status: "pending",
            },
          ],
        },
      ],
      "task-1",
      true,
      "plan-1",
    );

    expect(queue.map((item) => item.kind)).toEqual([
      "diagnostic",
      "command",
    ]);
    expect(queue[0]).toMatchObject({
      kind: "diagnostic",
      messageId: "message-1",
      plan: { id: "plan-1" },
      runs: [{ callId: "call-1" }],
    });
    expect(queue[1]).toMatchObject({
      kind: "command",
      proposal: { id: "command-pending" },
    });
  });

  test("does not surface persisted approvals without an active request", () => {
    expect(
      buildAiApprovalQueue(
        [
          {
            commandProposals: [command("command-1", "pending")],
            id: "message-1",
            taskId: "task-1",
          },
        ],
        "task-1",
        false,
        undefined,
      ),
    ).toEqual([]);
  });

  test("does not ask for diagnostics already allowed by backend policy", () => {
    const queue = buildAiApprovalQueue(
      [
        {
          diagnosticPlans: [
            {
              createdAt: "2026-07-30T08:00:00.000Z",
              id: "plan-auto",
              status: "pending",
              stepCallIds: ["call-1"],
            },
          ],
          id: "message-1",
          taskId: "task-1",
        },
      ],
      "task-1",
      true,
      undefined,
    );

    expect(queue).toEqual([]);
  });

  test("queues pending file actions after command approvals", () => {
    const queue = buildAiApprovalQueue(
      [
        {
          commandProposals: [command("command-1", "pending")],
          fileEditProposals: [
            {
              content: "next",
              id: "edit-1",
              originalFile: {
                content: "before",
                name: "app.conf",
                path: "/etc/app.conf",
                size: 6,
              },
              sessionId: "session-1",
              status: "pending",
            },
          ],
          fileOperationProposals: [
            {
              id: "operation-1",
              operation: "delete",
              originalFile: {
                content: "old",
                name: "old.conf",
                path: "/etc/old.conf",
                size: 3,
              },
              path: "/etc/old.conf",
              sessionId: "session-1",
              status: "pending",
            },
          ],
          id: "message-1",
          taskId: "task-1",
        },
      ],
      "task-1",
      true,
    );

    expect(queue.map((item) => item.kind)).toEqual([
      "command",
      "file-edit",
      "file-operation",
    ]);
  });
});
