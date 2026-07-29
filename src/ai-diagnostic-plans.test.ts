import { describe, expect, test } from "bun:test";
import {
  completeAiDiagnosticPlan,
  sanitizePersistedAiDiagnosticPlans,
} from "./ai-diagnostic-plans";
import type { AiToolRun } from "./ai-tools";

describe("AI diagnostic plans", () => {
  test("derives completed and partial terminal states", () => {
    const plan = {
      createdAt: "2026-07-28T10:00:00.000Z",
      id: "plan-1",
      status: "running" as const,
      stepCallIds: ["call-1", "call-2"],
    };
    const completedRuns: AiToolRun[] = [
      {
        callId: "call-1",
        label: "读取服务器状态",
        name: "get_server_status",
        planId: "plan-1",
        startedAt: 1_000,
        status: "success",
      },
      {
        callId: "call-2",
        label: "读取进程",
        name: "list_processes",
        optional: true,
        planId: "plan-1",
        startedAt: 1_000,
        status: "cancelled",
      },
    ];
    expect(completeAiDiagnosticPlan(plan, completedRuns).status).toBe(
      "completed",
    );
    const failedRuns = [
      completedRuns[0]!,
      { ...completedRuns[1]!, error: "失败", status: "failed" as const },
    ];
    expect(completeAiDiagnosticPlan(plan, failedRuns).status).toBe(
      "partial",
    );
  });

  test("persists only bounded terminal plan metadata", () => {
    expect(
      sanitizePersistedAiDiagnosticPlans([
        {
          createdAt: "2026-07-28T10:00:00.000Z",
          description: "使用 token=secret-value 检查服务",
          id: "plan-1",
          status: "partial",
          stepCallIds: ["call-1"],
          rawResults: "must-not-be-saved",
        },
        {
          createdAt: "2026-07-28T10:00:00.000Z",
          id: "plan-running",
          status: "running",
          stepCallIds: ["call-2"],
        },
      ]),
    ).toEqual([
      {
        createdAt: "2026-07-28T10:00:00.000Z",
        description: "使用 token=[已隐藏] 检查服务",
        id: "plan-1",
        status: "partial",
        stepCallIds: ["call-1"],
      },
    ]);
  });
});
