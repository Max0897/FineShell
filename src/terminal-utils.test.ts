import { describe, expect, test } from "bun:test";
import {
  appendInjectedTerminalInput,
  consumeTerminalCommandCandidate,
  decodeSshOutput,
  EMPTY_TERMINAL_INPUT_STATE,
  jumpHostRequest,
  reconnectDelaySeconds,
  sessionTabName,
  sshCredentialId,
  trackTerminalInput,
  terminalStatusNoticeKey,
} from "./terminal-utils";

describe("decodeSshOutput", () => {
  test("decodes unpadded SSH output without changing bytes", () => {
    expect(Array.from(decodeSshOutput("AAEC/4A"))).toEqual([
      0, 1, 2, 255, 128,
    ]);
  });
});

describe("terminal input tracking", () => {
  test("matches a manually submitted command that was inserted by AI", () => {
    const inserted = appendInjectedTerminalInput(
      EMPTY_TERMINAL_INPUT_STATE,
      "systemctl status nginx",
    );
    const result = trackTerminalInput(inserted, "\r");
    expect(result.submissions).toEqual(["systemctl status nginx"]);
    expect(result.state).toEqual(EMPTY_TERMINAL_INPUT_STATE);
  });

  test("tracks simple edits without guessing shell completion", () => {
    let result = trackTerminalInput(EMPTY_TERMINAL_INPUT_STATE, "echo noo");
    result = trackTerminalInput(result.state, "\u007fk");
    result = trackTerminalInput(result.state, "\r");
    expect(result.submissions).toEqual(["echo nok"]);

    result = trackTerminalInput(EMPTY_TERMINAL_INPUT_STATE, "echo value\t");
    result = trackTerminalInput(result.state, "\r");
    expect(result.submissions).toEqual([]);
  });

  test("resets after cancel and supports clearing the current line", () => {
    let result = trackTerminalInput(EMPTY_TERMINAL_INPUT_STATE, "wrong\u0015pwd\r");
    expect(result.submissions).toEqual(["pwd"]);

    result = trackTerminalInput(EMPTY_TERMINAL_INPUT_STATE, "secret\u0003\r");
    expect(result.submissions).toEqual([]);
  });

  test("does not report input after cursor control sequences", () => {
    let result = trackTerminalInput(
      EMPTY_TERMINAL_INPUT_STATE,
      "echo test\u001b[Dchanged",
    );
    result = trackTerminalInput(result.state, "\r");
    expect(result.submissions).toEqual([]);
    expect(result.state).toEqual(EMPTY_TERMINAL_INPUT_STATE);
  });

  test("consumes only an exact AI-inserted command candidate", () => {
    expect(
      consumeTerminalCommandCandidate(["pwd", "whoami"], "whoami"),
    ).toEqual({ candidates: ["pwd"], matched: true });
    expect(consumeTerminalCommandCandidate(["pwd"], "pwd -P")).toEqual({
      candidates: ["pwd"],
      matched: false,
    });
  });
});

describe("reconnectDelaySeconds", () => {
  test("uses capped exponential backoff", () => {
    expect(reconnectDelaySeconds(1)).toBe(1);
    expect(reconnectDelaySeconds(2)).toBe(2);
    expect(reconnectDelaySeconds(3)).toBe(4);
    expect(reconnectDelaySeconds(10)).toBe(30);
  });
});

describe("terminalStatusNoticeKey", () => {
  test("deduplicates connecting updates while preserving terminal errors", () => {
    expect(terminalStatusNoticeKey("connecting")).toBe("connecting");
    expect(terminalStatusNoticeKey("connecting", "等待确认主机指纹")).toBe(
      "connecting",
    );
    expect(terminalStatusNoticeKey("failed", "认证失败")).toBe(
      "failed:认证失败",
    );
    expect(terminalStatusNoticeKey("disconnected", "网络中断")).toBe(
      "disconnected:网络中断",
    );
  });
});

describe("sessionTabName", () => {
  test("numbers repeated sessions of the same saved host", () => {
    const sessions = [
      { id: "session-1", host: { id: "host-1", name: "Production" } },
      { id: "session-2", host: { id: "host-2", name: "Staging" } },
      { id: "session-3", host: { id: "host-1", name: "Production" } },
      { id: "session-4", host: { id: "host-1", name: "Production" } },
    ];

    expect(sessionTabName(sessions, "session-1")).toBe("Production");
    expect(sessionTabName(sessions, "session-2")).toBe("Staging");
    expect(sessionTabName(sessions, "session-3")).toBe("Production (2)");
    expect(sessionTabName(sessions, "session-4")).toBe("Production (3)");
    expect(sessionTabName(sessions.slice(1), "session-3")).toBe("Production");
  });
});

describe("jumpHostRequest", () => {
  test("maps the saved jump host and its proxy to the backend contract", () => {
    const request = jumpHostRequest({
      host: {
        id: "jump-1",
        name: "Jump",
        address: "jump.example.com",
        port: 2222,
        username: "deploy",
        authMethod: "privateKey",
        privateKeyPath: "/keys/jump",
        connectTimeoutSeconds: 12,
        keepAliveIntervalSeconds: 20,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        hostFingerprint: "SHA256:jump",
      },
      proxy: {
        id: "proxy-1",
        name: "Proxy",
        type: "socks5",
        address: "127.0.0.1",
        port: 1080,
      },
    });

    expect(request).toEqual({
      hostId: "jump-1",
      address: "jump.example.com",
      port: 2222,
      username: "deploy",
      authMethod: "privateKey",
      privateKeyPath: "/keys/jump",
      connectTimeoutSeconds: 12,
      keepAliveIntervalSeconds: 20,
      expectedFingerprint: "SHA256:jump",
      proxy: {
        id: "proxy-1",
        name: "Proxy",
        type: "socks5",
        address: "127.0.0.1",
        port: 1080,
      },
    });
    expect(jumpHostRequest()).toBeUndefined();
  });
});

describe("sshCredentialId", () => {
  test("uses a managed key id only for managed private key authentication", () => {
    const host = {
      id: "host-1",
      name: "Server",
      address: "server.example.com",
      port: 22,
      username: "root",
      authMethod: "privateKey" as const,
      sshKeyId: "ssh-key-1",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    };

    expect(sshCredentialId(host)).toBe("ssh-key-1");
    expect(sshCredentialId({ ...host, authMethod: "agent" })).toBe("host-1");
  });
});
