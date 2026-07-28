import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
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
        settings: {
          aiBaseUrl: "https://example.com/v1",
          aiModel: "test-model",
          aiToolsEnabled: true,
        },
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
      requestId: string;
    };

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
        settings: {
          aiBaseUrl: "https://example.com/v1",
          aiModel: "test-model",
          aiToolsEnabled: true,
        },
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
        settings: {
          aiBaseUrl: "https://example.com/v1",
          aiModel: "test-model",
          aiToolsEnabled: true,
        },
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
});
