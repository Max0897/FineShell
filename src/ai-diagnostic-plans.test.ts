import { describe, expect, test } from "bun:test";
import {
  completeAiDiagnosticPlan,
  createAiDiagnosticPlan,
  sanitizePersistedAiDiagnosticPlans,
} from "./ai-diagnostic-plans";
import { finishAiToolRun } from "./ai-tools";
import type { AiToolCall } from "./tauri-protocol";

function call(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown> = {},
): AiToolCall {
  return { id, name, arguments: JSON.stringify(argumentsValue) };
}

describe("AI diagnostic plans", () => {
  test("creates an ordered pending plan with visible active probe targets", () => {
    const { plan, runs } = createAiDiagnosticPlan(
      "plan-1",
      [
        call("call-1", "get_server_status", { reason: "确认资源使用情况" }),
        call("call-2", "ping_target", {
          target: "example.com",
          reason: "确认目标是否可达",
          optional: true,
          depends_on: [1],
        }),
      ],
      "先检查服务器资源，再确认外部网络。",
      ["get_server_status", "ping_target"],
      1_000,
    );

    expect(plan).toMatchObject({ id: "plan-1", status: "pending" });
    expect(runs[1]).toMatchObject({
      dependsOn: ["call-1"],
      detail: "example.com",
      optional: true,
      planId: "plan-1",
      reason: "确认目标是否可达",
      status: "pending",
    });
  });

  test("marks disabled tools unavailable before confirmation", () => {
    const { plan, runs } = createAiDiagnosticPlan(
      "plan-1",
      [call("call-1", "trace_route", { target: "example.com" })],
      "",
      ["get_server_status"],
    );
    expect(plan.status).toBe("partial");
    expect(runs[0]?.status).toBe("unavailable");
  });

  test("rejects duplicates, forward dependencies, and oversized plans", () => {
    expect(() =>
      createAiDiagnosticPlan(
        "plan-1",
        [
          call("call-1", "get_server_status"),
          call("call-2", "get_server_status"),
        ],
        "",
        ["get_server_status"],
      ),
    ).toThrow("重复步骤");
    expect(() =>
      createAiDiagnosticPlan(
        "plan-1",
        [call("call-1", "get_server_status", { depends_on: [1] })],
        "",
        ["get_server_status"],
      ),
    ).toThrow("此前的计划步骤");
    expect(() =>
      createAiDiagnosticPlan(
        "plan-1",
        Array.from({ length: 7 }, (_, index) =>
          call(`call-${index}`, "ping_target", { target: `host-${index}` }),
        ),
        "",
        ["ping_target"],
      ),
    ).toThrow("最多包含 6 个步骤");
  });

  test("derives completed and partial terminal states", () => {
    const created = createAiDiagnosticPlan(
      "plan-1",
      [
        call("call-1", "get_server_status"),
        call("call-2", "list_processes", { optional: true }),
      ],
      "",
      ["get_server_status", "list_processes"],
      1_000,
    );
    const completedRuns = [
      finishAiToolRun(created.runs[0]!, { summary: "完成" }, 1_100),
      finishAiToolRun(
        created.runs[1]!,
        { status: "cancelled", summary: "已取消" },
        1_100,
      ),
    ];
    expect(completeAiDiagnosticPlan(created.plan, completedRuns).status).toBe(
      "completed",
    );
    const failedRuns = [
      completedRuns[0]!,
      finishAiToolRun(
        created.runs[1]!,
        { error: "失败", status: "failed" },
        1_100,
      ),
    ];
    expect(completeAiDiagnosticPlan(created.plan, failedRuns).status).toBe(
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
