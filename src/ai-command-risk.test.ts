import { describe, expect, test } from "bun:test";
import cases from "../protocol/command-risk-cases.json";
import { classifyTerminalCommand } from "./ai-command-risk";

describe("AI terminal command risk", () => {
  test("classifies the cases shared with the backend", () => {
    for (const [commands, expected] of [
      [cases.readOnly, "read_only"],
      [cases.mutating, "mutating"],
      [cases.destructive, "destructive"],
    ] as const) {
      for (const command of commands) {
        expect({ command, risk: classifyTerminalCommand(command) }).toEqual({
          command,
          risk: expected,
        });
      }
    }
  });
});
