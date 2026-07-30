import { describe, expect, test } from "bun:test";
import {
  aiCommandApprovalDecisionFromSubmission,
  aiCommandApprovalToolResult,
  aiCommandProposalMatchesSubmission,
  aiCommandResultContextSource,
  aiCommandProposalToolResult,
  aiCommandRecordFromProposal,
  createAiCommandProposal,
  markAiCommandProposalCompleted,
  markAiCommandProposalExecuted,
  markAiCommandProposalApproved,
  markAiCommandProposalVerified,
} from "./ai-command-proposals";

function commandCall(argumentsValue: Record<string, unknown>) {
  const argumentsWithRisk = typeof argumentsValue.command === "string"
    ? {
        risk: "safe",
        risk_reason: "命令只读取当前状态",
        ...argumentsValue,
      }
    : argumentsValue;
  return {
    id: "command-1",
    name: "propose_terminal_command",
    arguments: JSON.stringify(argumentsWithRisk),
  };
}

describe("AI terminal command proposals", () => {
  test("parses a bounded single-line command and assesses risk locally", () => {
    const proposal = createAiCommandProposal(
      commandCall({
        command: "sudo systemctl restart nginx",
        purpose: "重启 nginx 服务",
      }),
      "session-1",
      "/srv/app",
    );
    expect(proposal).toMatchObject({
      command: "sudo systemctl restart nginx",
      directory: "/srv/app",
      purpose: "重启 nginx 服务",
      sessionId: "session-1",
      status: "pending",
    });
    expect(proposal.assessment.risk).toBe("caution");
  });

  test("preserves the AI assessment when local policy does not raise it", () => {
    const proposal = createAiCommandProposal(
      commandCall({
        command: "find /srv/app -type f",
        purpose: "列出应用文件",
        risk: "caution",
        risk_reason: "可能读取较大范围的目录结构",
      }),
      "session-1",
    );
    expect(proposal.assessment).toMatchObject({
      label: "需确认",
      reason: "可能读取较大范围的目录结构",
      risk: "caution",
    });
  });

  test("accepts only registered business verification descriptors", () => {
    const proposal = createAiCommandProposal(
      commandCall({
        command: "sudo systemctl restart nginx",
        purpose: "重启 nginx 服务",
        verification: {
          kind: "service_active",
          service: "nginx.service",
        },
      }),
      "session-1",
    );
    expect(proposal.verification).toEqual({
      kind: "service_active",
      service: "nginx.service",
    });
    expect(() =>
      createAiCommandProposal(
        commandCall({
          command: "sudo systemctl restart nginx",
          purpose: "重启 nginx 服务",
          verification: {
            kind: "service_active",
            service: "nginx; reboot",
          },
        }),
        "session-1",
      ),
    ).toThrow("业务验证参数无效");
  });

  test("rejects multiline, oversized, and unknown arguments", () => {
    expect(() =>
      createAiCommandProposal(
        commandCall({ command: "pwd\nwhoami", purpose: "检查环境" }),
        "session-1",
      ),
    ).toThrow("多行命令");
    expect(() =>
      createAiCommandProposal(
        commandCall({
          command: "pwd",
          purpose: "x".repeat(241),
        }),
        "session-1",
      ),
    ).toThrow("用途无效");
    expect(() =>
      createAiCommandProposal(
        commandCall({ command: "pwd", purpose: "检查目录", execute: true }),
        "session-1",
      ),
    ).toThrow("无效的终端命令参数");
  });

  test("records approval without persisting the raw command", () => {
    const proposal = createAiCommandProposal(
      commandCall({
        command: "curl -H 'Authorization: Bearer secret-token' example.com",
        purpose: "使用 token=secret-token 检查服务",
      }),
      "session-1",
    );
    const approved = markAiCommandProposalApproved(
      proposal,
      "2026-07-28T08:00:00.000Z",
    );
    const record = aiCommandRecordFromProposal(approved);
    expect(record).toEqual({
      id: "command-1",
      occurredAt: "2026-07-28T08:00:00.000Z",
      purpose: "使用 token=[已隐藏] 检查服务",
      risk: proposal.assessment.risk,
      status: "approved",
    });
    expect(JSON.stringify(record)).not.toContain("curl");
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  test("matches only the approved command submitted in the same session", () => {
    const proposal = markAiCommandProposalApproved(
      createAiCommandProposal(
        commandCall({ command: "pwd", purpose: "检查目录" }),
        "session-1",
      ),
      "2026-07-28T08:00:00.000Z",
    );
    const submission = {
      command: "pwd",
      hostId: "host-1",
      id: "submission-1",
      sessionId: "session-1",
      submittedAt: "2026-07-28T08:01:00.000Z",
    };
    expect(aiCommandProposalMatchesSubmission(proposal, submission)).toBe(true);
    expect(
      aiCommandProposalMatchesSubmission(proposal, {
        ...submission,
        sessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      aiCommandProposalMatchesSubmission(proposal, {
        ...submission,
        command: "whoami",
      }),
    ).toBe(false);

    const executed = markAiCommandProposalExecuted(proposal, submission);
    expect(executed).toMatchObject({
      executedAt: submission.submittedAt,
      status: "executed",
    });
    expect(
      markAiCommandProposalVerified(executed, "2026-07-28T08:02:00.000Z"),
    ).toMatchObject({
      status: "verified",
      verifiedAt: "2026-07-28T08:02:00.000Z",
    });
  });

  test("returns local validation errors without accepting a proposal", () => {
    expect(
      JSON.parse(
        aiCommandProposalToolResult(commandCall({}), "命令无效").content,
      ),
    ).toEqual({ error: "命令无效", ok: false });
  });

  test("returns the user's approval decision to the suspended tool call", () => {
    const call = commandCall({});
    expect(
      JSON.parse(
        aiCommandApprovalToolResult(call, {
          durationMs: 320,
          exitCode: 0,
          kind: "execution_completed",
          output: "nginx is active",
        }).content,
      ),
    ).toMatchObject({
      decision: "approved_and_completed",
      exitCode: 0,
      ok: true,
      output: "nginx is active",
    });
    expect(
      JSON.parse(
        aiCommandApprovalToolResult(call, {
          feedback: "改为只读检查",
          kind: "revision_requested",
        }).content,
      ),
    ).toMatchObject({
      decision: "revision_requested",
      feedback: "改为只读检查",
      ok: false,
    });
  });

  test("builds a bounded redacted approval result from shell integration", () => {
    expect(
      aiCommandApprovalDecisionFromSubmission({
        command: "printenv",
        completedAt: "2026-07-28T08:00:01.000Z",
        durationMs: 1_000,
        exitCode: 2,
        hostId: "host-1",
        id: "submission-1",
        output: "token=secret-value\npermission denied",
        phase: "completed",
        sessionId: "session-1",
        submittedAt: "2026-07-28T08:00:00.000Z",
      }),
    ).toMatchObject({
      durationMs: 1_000,
      exitCode: 2,
      kind: "execution_completed",
      output: "token=[已隐藏]\npermission denied",
    });
    expect(
      aiCommandApprovalDecisionFromSubmission({
        command: "top",
        durationMs: 30_000,
        hostId: "host-1",
        id: "submission-2",
        phase: "unavailable",
        reason: "未收到命令结束标记",
        sessionId: "session-1",
        submittedAt: "2026-07-28T08:00:00.000Z",
      }),
    ).toMatchObject({
      kind: "execution_unavailable",
      reason: "未收到命令结束标记",
    });
  });

  test("records a bounded command result without persisting its output", () => {
    const approved = markAiCommandProposalApproved(
      createAiCommandProposal(
        commandCall({ command: "false", purpose: "验证失败路径" }),
        "session-1",
      ),
    );
    const submission = {
      command: "false",
      hostId: "host-1",
      id: "submission-1",
      phase: "submitted" as const,
      sessionId: "session-1",
      submittedAt: "2026-07-28T08:01:00.000Z",
    };
    const executed = markAiCommandProposalExecuted(approved, submission);
    const completed = markAiCommandProposalCompleted(executed, {
      ...submission,
      completedAt: "2026-07-28T08:01:01.250Z",
      durationMs: 1_250,
      exitCode: 1,
      output: "token=must-not-leak\nfailed",
      phase: "completed",
    });

    expect(completed).toMatchObject({
      durationMs: 1_250,
      exitCode: 1,
      resultOutput: "token=[已隐藏]\nfailed",
      status: "failed",
    });
    expect(aiCommandResultContextSource(completed)?.content).toContain(
      "退出码: 1",
    );
    const record = aiCommandRecordFromProposal(completed);
    expect(record).toMatchObject({ durationMs: 1_250, exitCode: 1 });
    expect(JSON.stringify(record)).not.toContain("must-not-leak");
  });
});
