import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AppSettings } from "../app-settings";
import type { AiChatResult, AiToolCall } from "../tauri-protocol";
import {
  executeAiReadOnlyTool,
  useAiRequestOrchestrator,
  type AiRequestInvoke,
  type AiStreamListener,
} from "./useAiRequestOrchestrator";
import type { AiConversation, AiMessage } from "./useAiConversations";

function conversation(): AiConversation {
  return {
    createdAt: "2026-07-28T08:00:00.000Z",
    hostId: "host-1",
    hostName: "生产服务器",
    id: "conversation-1",
    messages: [],
    title: "新对话",
    updatedAt: "2026-07-28T08:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createConversationCallbacks() {
  let current = conversation();
  const updateConversation = mock(
    (
      _hostId: string,
      _conversationId: string,
      update: (value: AiConversation) => AiConversation,
    ) => {
      current = update(current);
      return current;
    },
  );
  const updateMessages = mock(
    (
      _hostId: string,
      _conversationId: string,
      update: (messages: AiMessage[]) => AiMessage[],
    ) => {
      current = { ...current, messages: update(current.messages) };
      return current;
    },
  );
  return {
    current: () => current,
    updateConversation,
    updateMessages,
  };
}

const baseSendOptions = {
  commandProposalEnabled: true,
  context: "",
  contextLabels: [],
  currentOperationDirectory: null,
  editableFiles: [],
  history: [],
  targetConversationId: "conversation-1",
  targetDirectory: "/root",
  targetHostId: "host-1",
  targetSessionId: "session-1",
  toolCurrentDirectory: "/root",
  value: "检查系统状态",
};

const aiSettings: Pick<
  AppSettings,
  | "aiBaseUrl"
  | "aiModel"
  | "aiReadOnlyTools"
  | "aiFileProposalsEnabled"
  | "aiCommandProposalsEnabled"
> = {
  aiBaseUrl: "https://example.com/v1",
  aiModel: "test-model",
  aiReadOnlyTools: [
    "get_server_status",
    "list_processes",
    "get_current_directory",
    "get_network_connections",
    "ping_target",
    "trace_route",
  ],
  aiFileProposalsEnabled: true,
  aiCommandProposalsEnabled: true,
};

describe("executeAiReadOnlyTool", () => {
  test("uses the captured SFTP directory without invoking a remote command", async () => {
    const invoke = mock(async () => {
      throw new Error("不应调用后端");
    }) as unknown as AiRequestInvoke;
    const result = await executeAiReadOnlyTool(
      {
        arguments: "{}",
        id: "call-1",
        name: "get_current_directory",
      },
      "session-1",
      "/srv/app",
      invoke,
    );

    expect(result.content).toContain("/srv/app");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("rejects calls outside the read-only allowlist", async () => {
    const call: AiToolCall = {
      arguments: "{}",
      id: "call-1",
      name: "write_file",
    };
    expect(
      executeAiReadOnlyTool(call, "session-1", "/root"),
    ).rejects.toThrow("不支持的工具");
  });
});

describe("useAiRequestOrchestrator", () => {
  test("streams only the active request and persists its completed answer", async () => {
    const response = deferred<AiChatResult>();
    const invokeMock = mock(
      async (command: string, _args?: Record<string, unknown>) => {
        if (command === "ai_chat_start") return response.promise;
        return undefined;
      },
    );
    const invoke = invokeMock as unknown as AiRequestInvoke;
    let onStream: Parameters<AiStreamListener>[0] = () => undefined;
    const listenToStream = mock(async (callback: typeof onStream) => {
      onStream = callback;
      return () => undefined;
    }) as AiStreamListener;
    const callbacks = createConversationCallbacks();
    const persistConversation = mock(async () => undefined);
    const setDraft = mock(() => undefined);
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke,
        listenToStream,
        persistConversation,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await waitFor(() => expect(listenToStream).toHaveBeenCalledTimes(1));
    let task!: Promise<AiConversation | undefined>;
    act(() => {
      task = result.current.sendMessage(baseSendOptions);
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const request = invokeMock.mock.calls[0]?.[1]?.request as {
      commandProposalEnabled: boolean;
      enabledTools: string[];
      fileEditEnabled: boolean;
      requestId: string;
    };
    expect(request.enabledTools).toEqual(aiSettings.aiReadOnlyTools);
    expect(request.fileEditEnabled).toBe(false);
    expect(request.commandProposalEnabled).toBe(true);

    act(() => {
      onStream({ delta: "正在分析", requestId: request.requestId });
      onStream({ delta: "忽略", requestId: "obsolete-request" });
    });
    expect(callbacks.current().messages[1]?.content).toBe("正在分析");

    await act(async () => {
      response.resolve({ content: "分析完成", toolCalls: [] });
      await task;
    });
    expect(callbacks.current().messages[1]?.content).toBe("分析完成");
    expect(setDraft).toHaveBeenCalledWith("conversation-1", "");
    expect(persistConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conversation-1" }),
    );
    expect(result.current.sending).toBe(false);
  });

  test("blocks a duplicate send while the first request is active", async () => {
    const response = deferred<AiChatResult>();
    const invoke = mock(async () => response.promise) as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke,
        listenToStream: async () => () => undefined,
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    let first!: Promise<AiConversation | undefined>;
    act(() => {
      first = result.current.sendMessage(baseSendOptions);
    });
    let duplicate: AiConversation | undefined;
    await act(async () => {
      duplicate = await result.current.sendMessage(baseSendOptions);
    });
    expect(duplicate).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve({ content: "完成", toolCalls: [] });
      await first;
    });
  });

  test("summarizes older messages in the background after saving the answer", async () => {
    const invokeMock = mock(
      async (_command: string, args?: Record<string, unknown>) => {
        const request = args?.request as { requestId: string };
        return request.requestId.startsWith("ai-summary-")
          ? { content: "## 目标\n确认服务状态", toolCalls: [] }
          : { content: "本次回答", toolCalls: [] };
      },
    );
    const callbacks = createConversationCallbacks();
    const persistConversation = mock(async () => undefined);
    const history: AiMessage[] = Array.from({ length: 18 }, (_, index) => ({
      content: `第 ${index + 1} 条消息`,
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
    }));
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke: invokeMock as unknown as AiRequestInvoke,
        listenToStream: async () => () => undefined,
        persistConversation,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ ...baseSendOptions, history });
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(callbacks.current().summary).toMatchObject({
        content: "## 目标\n确认服务状态",
        throughMessageId: "history-12",
      }),
    );
    expect(callbacks.current().messages).toHaveLength(20);
    expect(persistConversation).toHaveBeenCalledTimes(2);
    expect(result.current.summarizingConversationIds.size).toBe(0);
  });

  test("keeps the completed conversation when background summarization fails", async () => {
    const summaryError = new Error("summary unavailable");
    const invokeMock = mock(
      async (_command: string, args?: Record<string, unknown>) => {
        const request = args?.request as { requestId: string };
        if (request.requestId.startsWith("ai-summary-")) throw summaryError;
        return { content: "本次回答", toolCalls: [] };
      },
    );
    const callbacks = createConversationCallbacks();
    const onSummaryError = mock(() => undefined);
    const history: AiMessage[] = Array.from({ length: 18 }, (_, index) => ({
      content: `第 ${index + 1} 条消息`,
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
    }));
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke: invokeMock as unknown as AiRequestInvoke,
        listenToStream: async () => () => undefined,
        onSummaryError,
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ ...baseSendOptions, history });
    });
    await waitFor(() => expect(onSummaryError).toHaveBeenCalledWith(summaryError));
    expect(callbacks.current().summary).toBeUndefined();
    const completedMessages = callbacks.current().messages;
    expect(completedMessages[completedMessages.length - 1]?.content).toBe(
      "本次回答",
    );
  });

  test("cancels the active backend request and marks a rejected request as stopped", async () => {
    const response = deferred<AiChatResult>();
    const invokeMock = mock(
      async (command: string, _args?: Record<string, unknown>) => {
        if (command === "ai_chat_start") return response.promise;
        return undefined;
      },
    );
    const invoke = invokeMock as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke,
        listenToStream: async () => () => undefined,
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    let task!: Promise<AiConversation | undefined>;
    act(() => {
      task = result.current.sendMessage(baseSendOptions);
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.cancelRequest();
    });
    expect(invokeMock.mock.calls[1]?.[0]).toBe("ai_chat_cancel");

    await act(async () => {
      response.reject(new Error("request aborted"));
      await task;
    });
    expect(callbacks.current().messages[1]).toEqual(
      expect.objectContaining({ error: "已停止生成", failed: true }),
    );
  });

  test("does not execute a read-only tool disabled by the current settings", async () => {
    let chatRequests = 0;
    const invokeMock = mock(async (command: string) => {
      if (command !== "ai_chat_start") {
        throw new Error("不应执行远端诊断命令");
      }
      chatRequests += 1;
      return chatRequests === 1
        ? {
            content: "",
            toolCalls: [
              {
                arguments: '{"target":"example.com"}',
                id: "call-disabled",
                name: "trace_route",
              },
            ],
          }
        : { content: "权限已关闭", toolCalls: [] };
    });
    const confirmToolExecution = mock(async () => true);
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution,
        invoke: invokeMock as unknown as AiRequestInvoke,
        listenToStream: async () => () => undefined,
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: {
          ...aiSettings,
          aiReadOnlyTools: ["get_server_status"],
        },
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await act(async () => {
      await result.current.sendMessage(baseSendOptions);
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(confirmToolExecution).not.toHaveBeenCalled();
    expect(callbacks.current().messages[1]?.toolRuns?.[0]).toMatchObject({
      error: "只读工具权限已关闭",
      status: "cancelled",
    });
    expect(
      callbacks.current().messages[1]?.toolRuns?.[0]?.startedAt,
    ).toBeGreaterThan(1_000_000_000_000);
    expect(
      callbacks.current().messages[1]?.toolRuns?.[0]?.durationMs,
    ).toBeLessThan(60_001);
  });
});
