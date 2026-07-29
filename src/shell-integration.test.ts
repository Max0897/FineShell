import { describe, expect, test } from "bun:test";
import {
  FINESHELL_OSC_ID,
  MAX_SHELL_COMMAND_RESULT_CHARS,
  boundedShellCommandOutput,
  buildShellIntegrationInstallCommand,
  buildShellIntegrationUninstallCommand,
  createShellIntegrationEchoFilter,
  filterShellIntegrationEcho,
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
      parseShellIntegrationMessage("FineShell;nonce;disabled;tty", "nonce"),
    ).toEqual({ kind: "disabled" });
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
    expect(install).toContain("history -d");
    expect(install.endsWith("\r")).toBe(true);

    const uninstall = buildShellIntegrationUninstallCommand("safe-nonce");
    expect(uninstall).toContain("__fineshell_pc_decl");
    expect(uninstall).toContain("add-zsh-hook -d");
    expect(uninstall).toContain("disabled;tty");
  });

  test("gates redrawn installation input until the authenticated result arrives", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const marker = `\r\u001b[2K\u001b]${FINESHELL_OSC_ID};FineShell;stream-nonce;ready;zsh\u0007`;
    const redrawnEcho =
      "ubuntu@server:~$ stty -ec\r<server:~$ stty -echo\b\b\b\b\b";
    const combined = encoder.encode(`${redrawnEcho}\r\n${marker}next prompt`);
    const splitAt = redrawnEcho.length + Math.floor(marker.length / 2);
    let filter = createShellIntegrationEchoFilter("stream-nonce", "install");

    const first = filterShellIntegrationEcho(
      filter,
      combined.slice(0, splitAt),
    );
    expect(first.data).toHaveLength(0);
    expect(first.filter).toBeDefined();
    filter = first.filter!;

    const second = filterShellIntegrationEcho(filter, combined.slice(splitAt));
    expect(decoder.decode(second.data)).toBe(`${marker}next prompt`);
    expect(second.filter).toBeUndefined();
  });

  test("does not accept a marker created for another session", () => {
    const encoder = new TextEncoder();
    const filter = createShellIntegrationEchoFilter(
      "expected-nonce",
      "install",
    );
    const result = filterShellIntegrationEcho(
      filter,
      encoder.encode(
        `\r\u001b[2K\u001b]${FINESHELL_OSC_ID};FineShell;other-nonce;ready;bash\u0007`,
      ),
    );
    expect(result.data).toHaveLength(0);
    expect(result.filter).toBeDefined();
  });

  test("gates uninstallation output until its disabled marker", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const marker = `\r\u001b[2K\u001b]${FINESHELL_OSC_ID};FineShell;disable-nonce;disabled;tty\u0007`;
    const filter = createShellIntegrationEchoFilter(
      "disable-nonce",
      "uninstall",
    );
    const result = filterShellIntegrationEcho(
      filter,
      encoder.encode(`internal uninstall command${marker}prompt`),
    );
    expect(decoder.decode(result.data)).toBe(`${marker}prompt`);
    expect(result.filter).toBeUndefined();
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
