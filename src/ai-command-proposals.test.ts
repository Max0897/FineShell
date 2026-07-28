import { describe, expect, test } from "bun:test";
import {
  aiCommandProposalMatchesSubmission,
  aiCommandProposalToolResult,
  aiCommandRecordFromProposal,
  createAiCommandProposal,
  markAiCommandProposalExecuted,
  markAiCommandProposalInserted,
  markAiCommandProposalVerified,
} from "./ai-command-proposals";

function commandCall(argumentsValue: Record<string, unknown>) {
  return {
    id: "command-1",
    name: "propose_terminal_command",
    arguments: JSON.stringify(argumentsValue),
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

  test("records insertion without persisting the raw command", () => {
    const proposal = createAiCommandProposal(
      commandCall({
        command: "curl -H 'Authorization: Bearer secret-token' example.com",
        purpose: "使用 token=secret-token 检查服务",
      }),
      "session-1",
    );
    const inserted = markAiCommandProposalInserted(
      proposal,
      "2026-07-28T08:00:00.000Z",
    );
    const record = aiCommandRecordFromProposal(inserted);
    expect(record).toEqual({
      id: "command-1",
      purpose: "使用 token=[已隐藏] 检查服务",
      risk: proposal.assessment.risk,
      status: "inserted",
    });
    expect(JSON.stringify(record)).not.toContain("curl");
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  test("matches only a manually submitted command from the same session", () => {
    const proposal = markAiCommandProposalInserted(
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

  test("returns a review-only tool result", () => {
    expect(aiCommandProposalToolResult(commandCall({})).content).toContain(
      "尚未填入或执行",
    );
  });
});
