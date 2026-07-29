import { describe, expect, test } from "bun:test";
import { validateAiActionIntents } from "./ai-action-intents";
import type { AgentActionIntent, AiToolCall } from "./tauri-protocol";

function commandCall(): AiToolCall {
  return {
    id: "command-1",
    name: "propose_terminal_command",
    arguments: JSON.stringify({
      command: "  systemctl status nginx  ",
      purpose: "检查  nginx   状态",
    }),
  };
}

function commandIntent(): AgentActionIntent {
  return {
    id: "command-1",
    tool: "propose_terminal_command",
    arguments: {
      command: "systemctl status nginx",
      purpose: "检查 nginx 状态",
    },
    reason: "检查 nginx 状态",
    expectedEffect: "在当前终端会话中填入并执行命令",
    risk: "elevated",
  };
}

describe("AI action intents", () => {
  test("accepts a backend-normalized proposal intent", () => {
    expect(() =>
      validateAiActionIntents([commandCall()], [commandIntent()])
    ).not.toThrow();
  });

  test("rejects missing, duplicated, or mismatched intents", () => {
    expect(() => validateAiActionIntents([commandCall()], [])).toThrow(
      "数量不一致",
    );
    expect(() =>
      validateAiActionIntents(
        [commandCall(), { ...commandCall(), id: "command-2" }],
        [commandIntent(), commandIntent()],
      )
    ).toThrow("重复标识");
    expect(() =>
      validateAiActionIntents(
        [commandCall()],
        [{ ...commandIntent(), risk: "reversible_write" }],
      )
    ).toThrow("可信校验");
  });

  test("accepts diagnostics without action intents", () => {
    expect(() =>
      validateAiActionIntents(
        [{ id: "status-1", name: "get_server_status", arguments: "{}" }],
        [],
      )
    ).not.toThrow();
  });
});
