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
      status: "unavailable",
    });
    expect(
      callbacks.current().messages[1]?.toolRuns?.[0]?.startedAt,
    ).toBeGreaterThan(1_000_000_000_000);
    expect(
      callbacks.current().messages[1]?.toolRuns?.[0]?.durationMs,
    ).toBeLessThan(60_001);
  });

  test("waits for plan confirmation before executing tools in order", async () => {
    let chatRequests = 0;
    const commands: string[] = [];
    const invokeMock = mock(async (command: string) => {
      commands.push(command);
      if (command === "ai_chat_start") {
        chatRequests += 1;
        return chatRequests === 1
          ? {
              content: "先检查资源，再读取进程。",
              toolCalls: [
                {
                  arguments: '{"reason":"确认资源使用情况"}',
                  id: "call-status",
                  name: "get_server_status",
                },
                {
                  arguments:
                    '{"reason":"查找高占用进程","depends_on":[1]}',
                  id: "call-processes",
                  name: "list_processes",
                },
              ],
            }
          : { content: "诊断完成", toolCalls: [] };
      }
      if (command === "ssh_monitor_snapshot") {
        return {
          hostname: "server",
          operatingSystem: "Linux",
          kernel: "6.8",
          uptimeSeconds: 100,
          loadAverage: [0.1, 0.2, 0.3],
          cpuUsagePercent: 10,
          memoryTotalBytes: 100,
          memoryUsedBytes: 20,
          memoryUsagePercent: 20,
          diskTotalBytes: 100,
          diskUsedBytes: 30,
          diskUsagePercent: 30,
          networkReceiveBytes: 1,
          networkTransmitBytes: 2,
        };
      }
      if (command === "ssh_processes") {
        return { processes: [], truncated: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const callbacks = createConversationCallbacks();
    const confirmToolExecution = mock(async () => true);
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution,
        invoke: invokeMock as unknown as AiRequestInvoke,
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
    await waitFor(() =>
      expect(
        callbacks.current().messages[1]?.diagnosticPlans?.[0]?.status,
      ).toBe("pending"),
    );
    expect(commands).toEqual(["ai_chat_start"]);
    const plan = callbacks.current().messages[1]!.diagnosticPlans![0]!;
    expect(callbacks.current().messages[1]?.toolRuns?.[0]).toMatchObject({
      reason: "确认资源使用情况",
      status: "pending",
    });

    act(() => {
      result.current.confirmDiagnosticPlan(plan.id, plan.stepCallIds);
    });
    await act(async () => {
      await task;
    });

    expect(commands).toEqual([
      "ai_chat_start",
      "ssh_monitor_snapshot",
      "ssh_processes",
      "ai_chat_start",
    ]);
    expect(confirmToolExecution).not.toHaveBeenCalled();
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[0]?.status).toBe(
      "completed",
    );
    expect(
      callbacks.current().messages[1]?.toolRuns?.map((run) => run.status),
    ).toEqual(["success", "success"]);
  });

  test("cancels an unconfirmed active probe without executing it", async () => {
    let chatRequests = 0;
    const invokeMock = mock(async (command: string) => {
      if (command === "ai_chat_start") {
        chatRequests += 1;
        return chatRequests === 1
          ? {
              content: "确认外部网络。",
              toolCalls: [
                {
                  arguments:
                    '{"target":"example.com","reason":"确认目标是否可达"}',
                  id: "call-ping",
                  name: "ping_target",
                },
              ],
            }
          : { content: "已取消网络诊断", toolCalls: [] };
      }
      throw new Error("未确认计划不应执行远端诊断");
    });
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke: invokeMock as unknown as AiRequestInvoke,
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
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.toolRuns?.[0]).toMatchObject({
        detail: "example.com",
        status: "pending",
      }),
    );
    const planId = callbacks.current().messages[1]!.diagnosticPlans![0]!.id;
    act(() => result.current.cancelDiagnosticPlan(planId));
    await act(async () => {
      await task;
    });

    expect(invokeMock.mock.calls.map((item) => item[0])).toEqual([
      "ai_chat_start",
      "ai_chat_start",
    ]);
    expect(callbacks.current().messages[1]?.toolRuns?.[0]?.status).toBe(
      "cancelled",
    );
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[0]?.status).toBe(
      "cancelled",
    );
  });

  test("continues independent steps after failure and previews supplemental plans again", async () => {
    let chatRequests = 0;
    const invokeMock = mock(async (command: string) => {
      if (command === "ai_chat_start") {
        chatRequests += 1;
        if (chatRequests === 1) {
          return {
            content: "第一轮计划",
            toolCalls: [
              {
                arguments: '{"reason":"读取资源"}',
                id: "call-failed",
                name: "get_server_status",
              },
              {
                arguments: '{"reason":"读取连接"}',
                id: "call-connections",
                name: "get_network_connections",
              },
            ],
          };
        }
        if (chatRequests === 2) {
          return {
            content: "补充检查当前目录",
            toolCalls: [
              {
                arguments: '{"reason":"确认工作目录"}',
                id: "call-directory",
                name: "get_current_directory",
              },
            ],
          };
        }
        return { content: "完成", toolCalls: [] };
      }
      if (command === "ssh_monitor_snapshot") throw new Error("读取失败");
      if (command === "ssh_network_connections") {
        return { connections: [], truncated: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke: invokeMock as unknown as AiRequestInvoke,
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
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.diagnosticPlans).toHaveLength(1),
    );
    const firstPlan = callbacks.current().messages[1]!.diagnosticPlans![0]!;
    act(() =>
      result.current.confirmDiagnosticPlan(firstPlan.id, firstPlan.stepCallIds),
    );
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.diagnosticPlans).toHaveLength(2),
    );
    expect(
      callbacks.current().messages[1]?.toolRuns?.slice(0, 2).map((run) =>
        run.status,
      ),
    ).toEqual(["failed", "success"]);
    expect(invokeMock.mock.calls.map((item) => item[0])).not.toContain(
      "ssh_current_directory",
    );
    const secondPlan = callbacks.current().messages[1]!.diagnosticPlans![1]!;
    expect(secondPlan.status).toBe("pending");
    act(() =>
      result.current.confirmDiagnosticPlan(secondPlan.id, secondPlan.stepCallIds),
    );
    await act(async () => {
      await task;
    });
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[1]?.status).toBe(
      "completed",
    );
  });

  test("stops remaining steps after the active step finishes", async () => {
    const snapshot = deferred<unknown>();
    let chatRequests = 0;
    const invokeMock = mock(async (command: string) => {
      if (command === "ai_chat_start") {
        chatRequests += 1;
        return chatRequests === 1
          ? {
              content: "顺序检查",
              toolCalls: [
                {
                  arguments: "{}",
                  id: "call-status",
                  name: "get_server_status",
                },
                {
                  arguments: "{}",
                  id: "call-processes",
                  name: "list_processes",
                },
              ],
            }
          : { content: "已基于部分结果完成分析", toolCalls: [] };
      }
      if (command === "ssh_monitor_snapshot") return snapshot.promise;
      throw new Error(`不应执行：${command}`);
    });
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        confirmToolExecution: async () => true,
        invoke: invokeMock as unknown as AiRequestInvoke,
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
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.diagnosticPlans).toHaveLength(1),
    );
    const currentPlan = callbacks.current().messages[1]!.diagnosticPlans![0]!;
    act(() =>
      result.current.confirmDiagnosticPlan(
        currentPlan.id,
        currentPlan.stepCallIds,
      ),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((item) => item[0] === "ssh_monitor_snapshot"),
      ).toBe(true),
    );
    act(() => result.current.stopDiagnosticPlan(currentPlan.id));
    expect(
      callbacks.current().messages[1]?.diagnosticPlans?.[0]?.stopRequested,
    ).toBe(true);
    await act(async () => {
      snapshot.resolve({
        hostname: "server",
        operatingSystem: "Linux",
        kernel: "6.8",
        uptimeSeconds: 100,
        loadAverage: [0.1, 0.2, 0.3],
        cpuUsagePercent: 10,
        memoryTotalBytes: 100,
        memoryUsedBytes: 20,
        memoryUsagePercent: 20,
        diskTotalBytes: 100,
        diskUsedBytes: 30,
        diskUsagePercent: 30,
        networkReceiveBytes: 1,
        networkTransmitBytes: 2,
      });
      await task;
    });

    expect(invokeMock.mock.calls.map((item) => item[0])).not.toContain(
      "ssh_processes",
    );
    expect(
      callbacks.current().messages[1]?.toolRuns?.map((run) => run.status),
    ).toEqual(["success", "cancelled"]);
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[0]?.status).toBe(
      "partial",
    );
  });
});
