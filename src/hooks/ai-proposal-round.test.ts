import { describe, expect, test } from "bun:test";
import {
  prepareAiProposalRound,
  resolveAiProposalRound,
} from "./ai-proposal-round";

const commandCall = {
  id: "command-1",
  name: "propose_terminal_command",
  arguments: JSON.stringify({
    command: "systemctl status nginx",
    purpose: "查看 Nginx 状态",
    risk: "safe",
    risk_reason: "命令只读取当前状态",
  }),
};

function prepare(calls = [commandCall], proposedCommands = new Set<string>()) {
  return prepareAiProposalRound({
    calls,
    currentOperationDirectory: null,
    editableFiles: [],
    fileProposalEnabled: false,
    proposedCommands,
    proposedFilePaths: new Set(),
    requestId: "request-1",
    targetDirectory: "/srv/app",
    targetSessionId: "session-1",
    terminalProposalEnabled: true,
    waitForCommandApproval: async () => ({
      exitCode: 0,
      kind: "execution_completed",
      output: "active",
    }),
    waitForFileApproval: async () => ({ kind: "rejected" }),
  });
}

describe("AI proposal rounds", () => {
  test("captures a command and resolves its approval result", async () => {
    const round = prepare();

    expect(round.commandProposals).toHaveLength(1);
    expect(round.commandProposals[0]).toMatchObject({
      command: "systemctl status nginx",
      directory: "/srv/app",
      status: "pending",
    });

    const results = await resolveAiProposalRound(
      [commandCall],
      round,
      () => false,
    );
    expect(JSON.parse(results[0]!.content)).toMatchObject({
      decision: "approved_and_completed",
      exitCode: 0,
      ok: true,
      output: "active",
    });
  });

  test("rejects duplicate commands across proposal rounds", () => {
    const proposedCommands = new Set<string>();
    prepare([commandCall], proposedCommands);
    const duplicate = prepare([commandCall], proposedCommands);

    expect(duplicate.commandProposals).toHaveLength(0);
    expect(JSON.parse(duplicate.proposalResults.get(commandCall.id)!.content))
      .toMatchObject({ ok: false, error: "AI 重复返回了同一条终端命令" });
  });

  test("rejects tool calls outside the proposal protocol", () => {
    expect(() =>
      prepare([
        { id: "unknown-1", name: "unknown_tool", arguments: "{}" },
      ]),
    ).toThrow("AI 后端返回了未处理的工具调用：unknown_tool");
  });
});
