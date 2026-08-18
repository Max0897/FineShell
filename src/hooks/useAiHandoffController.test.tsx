import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { AiHandoffRequest } from "../ai-handoff";
import type { AiContextSource, AiRemoteFileContext } from "../ai-utils";
import type { HostRecord, TerminalSession } from "../models";
import useAiHandoffController, {
  aiHandoffTargetError,
} from "./useAiHandoffController";

const HOST: HostRecord = {
  id: "host-1",
  name: "测试服务器",
  address: "server.example.com",
  port: 22,
  username: "root",
  authMethod: "password",
  connectTimeoutSeconds: 10,
  keepAliveIntervalSeconds: 15,
  autoReconnect: true,
  maxReconnectAttempts: 3,
};

const SESSION: TerminalSession = {
  id: "session-1",
  host: HOST,
  openedAt: "2026-08-11T00:00:00.000Z",
  status: "connected",
};

function renderHandoffController(options?: {
  activeSession?: TerminalSession | null;
  openAssistant?: () => Promise<boolean>;
  openAssistantResult?: boolean;
}) {
  const onNotice = mock(() => undefined);
  const openAssistant = mock(
    options?.openAssistant ??
      (async () => options?.openAssistantResult ?? true),
  );
  const view = renderHook(() => {
    const [businessContexts, setBusinessContexts] = useState<
      Record<string, AiContextSource[]>
    >({});
    const [remoteFileContexts, setRemoteFileContexts] = useState<
      Record<string, AiRemoteFileContext[]>
    >({});
    const [terminalSelections, setTerminalSelections] = useState<
      Record<string, string>
    >({});
    const controller = useAiHandoffController({
      activeSession: options?.activeSession ?? SESSION,
      businessContexts,
      onNotice,
      openAssistant,
      remoteFileContexts,
      setBusinessContexts,
      setRemoteFileContexts,
      setTerminalSelections,
      terminalSelections,
    });
    return {
      ...controller,
      businessContexts,
      remoteFileContexts,
      terminalSelections,
    };
  });
  return { ...view, onNotice, openAssistant };
}

describe("useAiHandoffController", () => {
  test("rejects missing, switched, and disconnected sessions", () => {
    expect(aiHandoffTargetError(null, SESSION.id)).toBe("请先打开终端会话");
    expect(aiHandoffTargetError(SESSION, "session-2")).toBe(
      "当前会话已切换，请重新选择要分析的内容",
    );
    expect(
      aiHandoffTargetError({ ...SESSION, status: "disconnected" }, SESSION.id),
    ).toBe("当前会话不可用，请恢复连接后重试");
  });

  test("redacts and replaces business context before opening AI", async () => {
    const view = renderHandoffController();
    const request: AiHandoffRequest = {
      prompt: "分析进程",
      source: {
        id: "process-selection",
        label: "所选进程",
        content: "env SERVICE_API_TOKEN=secret-value server",
      },
    };

    await act(async () => {
      expect(
        await view.result.current.handoffContext(SESSION.id, request),
      ).toBe(true);
    });

    expect(
      view.result.current.businessContexts[SESSION.id]?.[0]?.content,
    ).not.toContain("secret-value");
    expect(view.openAssistant).toHaveBeenCalledWith(SESSION.id, "分析进程", [
      "process-selection",
    ]);
  });

  test("hands off a redacted terminal selection through the same boundary", async () => {
    const view = renderHandoffController();

    await act(async () => {
      expect(
        await view.result.current.handoffTerminalSelection(
          SESSION.id,
          "DATABASE_URL=postgres://root:secret@example.com/app",
        ),
      ).toBe(true);
    });

    expect(view.result.current.terminalSelections[SESSION.id]).not.toContain(
      "secret",
    );
    expect(view.openAssistant).toHaveBeenCalledWith(
      SESSION.id,
      "请解释这段终端输出，并给出排查建议。",
      ["terminal-selection"],
    );
  });

  test("merges remote files and rejects a stale session", async () => {
    const view = renderHandoffController();
    const file: AiRemoteFileContext = {
      content: "server { listen 80; }",
      name: "nginx.conf",
      path: "/etc/nginx/nginx.conf",
      size: 21,
    };

    await act(async () => {
      expect(
        await view.result.current.handoffRemoteFiles(SESSION.id, [file]),
      ).toBe(true);
    });
    expect(view.result.current.remoteFileContexts[SESSION.id]).toEqual([file]);
    expect(view.openAssistant).toHaveBeenCalledWith(SESSION.id, "", [
      "sftp-file:/etc/nginx/nginx.conf",
    ]);

    await act(async () => {
      expect(
        await view.result.current.handoffRemoteFiles("session-2", [file]),
      ).toBe(false);
    });
    expect(view.openAssistant).toHaveBeenCalledTimes(1);
    expect(view.onNotice).toHaveBeenLastCalledWith(
      "warning",
      "当前会话已切换，请重新选择要分析的内容",
    );
  });

  test("does not report success when the target changes while opening AI", async () => {
    const view = renderHandoffController({ openAssistantResult: false });
    const request: AiHandoffRequest = {
      prompt: "分析网络",
      source: {
        id: "network-diagnostic",
        label: "网络诊断",
        content: "连接正常",
      },
    };

    await act(async () => {
      expect(
        await view.result.current.handoffContext(SESSION.id, request),
      ).toBe(false);
    });

    expect(view.onNotice).toHaveBeenLastCalledWith(
      "warning",
      "当前会话已切换，请重新选择要分析的内容",
    );
    expect(view.result.current.businessContexts[SESSION.id]).toBeUndefined();
  });

  test("rolls back terminal selections and remote files when opening fails", async () => {
    const view = renderHandoffController({ openAssistantResult: false });
    const file: AiRemoteFileContext = {
      content: "server { listen 80; }",
      name: "nginx.conf",
      path: "/etc/nginx/nginx.conf",
      size: 21,
    };

    await act(async () => {
      expect(
        await view.result.current.handoffTerminalSelection(
          SESSION.id,
          "需要分析的输出",
        ),
      ).toBe(false);
      expect(
        await view.result.current.handoffRemoteFiles(SESSION.id, [file]),
      ).toBe(false);
    });

    expect(view.result.current.terminalSelections[SESSION.id]).toBeUndefined();
    expect(view.result.current.remoteFileContexts[SESSION.id]).toBeUndefined();
  });

  test("does not let an older failed handoff roll back a newer context", async () => {
    let resolveFirst: ((opened: boolean) => void) | undefined;
    let callCount = 0;
    const view = renderHandoffController({
      openAssistant: () => {
        callCount += 1;
        if (callCount > 1) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        });
      },
    });
    const request = (content: string): AiHandoffRequest => ({
      prompt: "分析进程",
      source: {
        id: "process-selection",
        label: "所选进程",
        content,
      },
    });
    let firstHandoff: Promise<boolean> | undefined;

    await act(async () => {
      firstHandoff = view.result.current.handoffContext(
        SESSION.id,
        request("旧上下文"),
      );
      await Promise.resolve();
    });
    await act(async () => {
      expect(
        await view.result.current.handoffContext(
          SESSION.id,
          request("新上下文"),
        ),
      ).toBe(true);
    });
    await act(async () => {
      resolveFirst?.(false);
      expect(await firstHandoff).toBe(false);
    });

    expect(view.result.current.businessContexts[SESSION.id]?.[0]?.content).toBe(
      "新上下文",
    );
  });
});
