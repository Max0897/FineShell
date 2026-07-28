import { describe, expect, test } from "bun:test";
import {
  FINESHELL_OSC_ID,
  MAX_SHELL_COMMAND_RESULT_CHARS,
  boundedShellCommandOutput,
  buildShellIntegrationInstallCommand,
  buildShellIntegrationUninstallCommand,
  parseShellIntegrationMessage,
} from "./shell-integration";

describe("shell integration", () => {
  test("accepts only scoped OSC lifecycle messages", () => {
    expect(
      parseShellIntegrationMessage("FineShell;nonce;ready;bash", "nonce"),
    ).toEqual({ kind: "ready", shell: "bash" });
    expect(
      parseShellIntegrationMessage("FineShell;nonce;end;17", "nonce"),
    ).toEqual({ kind: "end", exitCode: 17 });
    expect(
      parseShellIntegrationMessage(
        "FineShell;nonce;unavailable;unsupported-shell",
        "nonce",
      ),
    ).toEqual({ kind: "unavailable", reason: "unsupported-shell" });
    expect(
      parseShellIntegrationMessage("FineShell;other;end;0", "nonce"),
    ).toBeNull();
    expect(
      parseShellIntegrationMessage("FineShell;nonce;end;999", "nonce"),
    ).toBeNull();
  });

  test("builds session-only bash and zsh hooks with a removable marker", () => {
    const install = buildShellIntegrationInstallCommand("safe-nonce");
    expect(install).toContain(`]${FINESHELL_OSC_ID};FineShell;`);
    expect(install).toContain("BASH_VERSION");
    expect(install).toContain("ZSH_VERSION");
    expect(install).toContain("PROMPT_COMMAND");
    expect(install).toContain("add-zsh-hook");
    expect(install.endsWith("\r")).toBe(true);

    const uninstall = buildShellIntegrationUninstallCommand();
    expect(uninstall).toContain("__fineshell_pc_decl");
    expect(uninstall).toContain("add-zsh-hook -d");
  });

  test("keeps only the bounded tail of a command result", () => {
    expect(boundedShellCommandOutput("ok\r\n")).toEqual({
      output: "ok",
      truncated: false,
    });
    const result = boundedShellCommandOutput(
      `prefix${"x".repeat(MAX_SHELL_COMMAND_RESULT_CHARS)}`,
    );
    expect(result.output).toHaveLength(MAX_SHELL_COMMAND_RESULT_CHARS);
    expect(result.output.startsWith("x")).toBe(true);
    expect(result.truncated).toBe(true);
  });
});
