import { describe, expect, test } from "bun:test";
import {
  AI_PROMPT_PRESETS,
  availablePresetContextIds,
} from "./ai-presets";

describe("AI prompt presets", () => {
  test("keeps only context sources that currently contain data", () => {
    const preset = AI_PROMPT_PRESETS.find(
      (item) => item.id === "explain-output",
    )!;
    expect(
      availablePresetContextIds(preset, [
        { id: "terminal-selection", label: "终端选区", content: "" },
        { id: "terminal-output", label: "最近输出", content: "uname -a" },
        { id: "server-monitor", label: "服务器状态", content: "CPU 10%" },
      ]),
    ).toEqual(["terminal-output"]);
  });

  test("presets prepare prompts without defining an automatic send action", () => {
    expect(AI_PROMPT_PRESETS).toHaveLength(4);
    expect(AI_PROMPT_PRESETS.every((preset) => preset.prompt.trim())).toBe(true);
    expect(AI_PROMPT_PRESETS.map((preset) => preset.id)).toEqual([
      "explain-output",
      "analyze-server",
      "diagnose-network",
      "generate-command",
    ]);
  });
});
