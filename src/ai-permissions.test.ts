import { describe, expect, test } from "bun:test";
import {
  ALL_AI_READ_ONLY_TOOLS,
  aiReadOnlyToolEnabled,
  sanitizeAiReadOnlyTools,
} from "./ai-permissions";

describe("AI permission settings", () => {
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
