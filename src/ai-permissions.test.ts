import { describe, expect, test } from "bun:test";
import {
  AI_READ_ONLY_TOOL_OPTIONS,
  ALL_AI_READ_ONLY_TOOLS,
  aiReadOnlyToolLabel,
  aiReadOnlyToolEnabled,
  sanitizeAiReadOnlyTools,
} from "./ai-permissions";

describe("AI permission settings", () => {
  test("derives names and labels from the shared tool catalog", () => {
    expect(AI_READ_ONLY_TOOL_OPTIONS).toHaveLength(8);
    expect(aiReadOnlyToolLabel("inspect_service")).toBe("检查服务状态");
    expect(AI_READ_ONLY_TOOL_OPTIONS.map(({ value }) => value)).toEqual(
      ALL_AI_READ_ONLY_TOOLS,
    );
  });

  test("migrates the legacy master switch without broadening access", () => {
    expect(sanitizeAiReadOnlyTools(undefined, false)).toEqual([]);
    expect(sanitizeAiReadOnlyTools(undefined, true)).toEqual(
      ALL_AI_READ_ONLY_TOOLS,
    );
  });

  test("keeps only known tools and removes duplicates", () => {
    expect(
      sanitizeAiReadOnlyTools([
        "list_processes",
        "unknown_tool",
        "list_processes",
        "ping_target",
      ]),
    ).toEqual(["list_processes", "ping_target"]);
  });

  test("checks one explicit permission at a time", () => {
    expect(aiReadOnlyToolEnabled(["get_server_status"], "get_server_status"))
      .toBe(true);
    expect(aiReadOnlyToolEnabled(["get_server_status"], "trace_route")).toBe(
      false,
    );
  });
});
