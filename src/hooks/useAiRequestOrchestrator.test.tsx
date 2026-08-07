import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AppSettings } from "../app-settings";
import {
  PROTOCOL_VERSION,
  type AgentPlan,
  type AgentTask,
  type AiChatResult,
} from "../tauri-protocol";
import {
  useAiRequestOrchestrator,
  type AiRequestInvoke,
  type AiStreamListener,
  type AiTaskListener,
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

function agentTask(
  id: string,
  status: AgentTask["status"] = "running",
  sequence = 2,
): AgentTask {
  return {
    activeStepId: null,
    approvalMode: "on_request",
    contextCapturedAt: Date.now(),
    contextVersion: 1,
    conversationId: "conversation-1",
    currentDirectory: null,
    createdAt: 1,
    error: null,
    hostId: "host-1",
    id,
    iteration: 1,
    repairAttempts: 0,
    repairLimit: 2,
    repairStopReason: null,
    lastEventSequence: sequence,
    objective: "检查系统状态",
    actions: [],
    diagnostics: {
      actionCount: 0,
      durationMs: 1,
      modelTurnCount: 1,
      planStepCount: 0,
      repairAttemptCount: 0,
      stopReason: null,
      verificationEvidenceCount: 0,
    },
    modelCompleted: status === "completed",
    plan: null,
    result: null,
    status,
    terminalSessionId: "session-1",
    updatedAt: 2,
  };
}

describe("useAiRequestOrchestrator", () => {
  test("leaves tool-loop finalization to the Rust agent runtime", async () => {
    const requests: Array<{ toolRounds: unknown[] }> = [];
    const invokeMock = mock(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "ai_task_action_results") {
          const request = args?.request as {
            calls: Array<{ id: string; name: string }>;
          };
          return request.calls.map((call) => ({
            callId: call.id,
            content: JSON.stringify({
              decision: "approved_and_completed",
              message: "远程文件已更新",
              ok: true,
            }),
            name: call.name,
          }));
        }
        if (command !== "ai_chat_start") {
          throw new Error(`unexpected command: ${command}`);
        }
        const request = args?.request as { toolRounds: unknown[] };
        requests.push(request);
        if (request.toolRounds.length >= 8) {
          return {
            content: "已根据现有诊断结果完成总结，未执行更多工具。",
            toolCalls: [],
          };
        }
        const index = request.toolRounds.length;
        const path = `/tmp/round-${index}.txt`;
        const content = `round-${index}`;
        return {
          actionIntents: [
            {
              arguments: { content, path },
              expectedEffect: "完整替换指定远程文件的内容",
              id: `call-edit-${index}`,
              reason: `修改 ${path}`,
              risk: "reversible_write",
              tool: "propose_file_edit",
            },
          ],
          content: "",
          toolCalls: [
            {
              arguments: JSON.stringify({ content, path }),
              id: `call-edit-${index}`,
              name: "propose_file_edit",
            },
          ],
        };
      },
    );
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
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

    let send!: Promise<AiConversation | undefined>;
    act(() => {
      send = result.current.sendMessage({
        ...baseSendOptions,
        context: Array.from(
          { length: 8 },
          (_, index) => `/tmp/round-${index}.txt\nold-${index}`,
        ).join("\n"),
        editableFiles: Array.from({ length: 8 }, (_, index) => ({
          content: `old-${index}`,
          name: `round-${index}.txt`,
          path: `/tmp/round-${index}.txt`,
          size: 5,
        })),
      });
    });

    for (let index = 0; index < 8; index += 1) {
      await waitFor(() =>
        expect(
          callbacks.current().messages[1]?.fileEditProposals,
        ).toHaveLength(index + 1),
      );
      act(() => {
        expect(
          result.current.decideFileProposal(`call-edit-${index}`, {
            kind: "execution_completed",
            summary: "远程文件已更新",
          }),
        ).toBe(true);
      });
    }
    await act(async () => {
      await send;
    });

    expect(requests).toHaveLength(9);
    expect(requests.every((request) => !("finalizeReason" in request))).toBe(
      true,
    );
    expect(requests[requests.length - 1]?.toolRounds).toHaveLength(8);
    expect(callbacks.current().messages[1]).toMatchObject({
      content: "已根据现有诊断结果完成总结，未执行更多工具。",
      failed: false,
    });
    expect(callbacks.current().messages[1]?.fileEditProposals).toHaveLength(8);
  });

  test("pauses a terminal tool call until terminal execution completes", async () => {
    const requests: Array<{
      toolRounds: Array<{
        reasoningContent?: string;
        results: Array<{ content: string }>;
      }>;
    }> = [];
    const invoke = mock(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "ai_task_action_results") {
          return [
            {
              callId: "command-approval-1",
              content: JSON.stringify({
                decision: "approved_and_completed",
                exitCode: 0,
                ok: true,
                output: "Mem: 1.8Gi used, 2.0Gi free",
              }),
              name: "propose_terminal_command",
            },
          ];
        }
        if (command !== "ai_chat_start") {
          throw new Error(`unexpected command: ${command}`);
        }
        const request = args?.request as (typeof requests)[number];
        requests.push(request);
        if (request.toolRounds.length) {
          return {
            content: "命令执行成功，当前内存状态正常。",
            telemetry: {
              durationMs: 450,
              requestCount: 1,
              usage: {
                cachedInputTokens: 20,
                inputTokens: 200,
                outputTokens: 40,
                reasoningTokens: 10,
                totalTokens: 240,
              },
            },
            toolCalls: [],
          };
        }
        return {
          actionIntents: [
            {
              arguments: { command: "systemctl restart nginx", purpose: "重启 Nginx" },
              expectedEffect: "在当前终端会话中填入命令，等待用户手动提交",
              id: "command-approval-1",
              reason: "重启 Nginx",
              risk: "elevated",
              tool: "execute_terminal_command",
            },
          ],
          content: "需要执行一项终端操作。",
          reasoningContent: "inspect service state before continuing",
          telemetry: {
            durationMs: 300,
            requestCount: 2,
            usage: {
              cachedInputTokens: 10,
              inputTokens: 100,
              outputTokens: 20,
              reasoningTokens: 5,
              totalTokens: 120,
            },
          },
          toolCalls: [
            {
              arguments: JSON.stringify({
                command: "systemctl restart nginx",
                purpose: "重启 Nginx",
                risk: "caution",
                risk_reason: "会重启正在运行的服务",
              }),
              id: "command-approval-1",
              name: "propose_terminal_command",
            },
          ],
        };
      },
    ) as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const persistConversation = mock(async () => undefined);
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        invoke,
        listenToStream: async () => () => undefined,
        persistConversation,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    let send!: Promise<AiConversation | undefined>;
    act(() => {
      send = result.current.sendMessage(baseSendOptions);
    });
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.commandProposals).toHaveLength(1),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.sending).toBe(true);
    expect(callbacks.current().messages[1]?.content).toBe("");

    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => {
      expect(
        result.current.decideCommandProposal("command-approval-1", {
          durationMs: 850,
          exitCode: 0,
          kind: "execution_completed",
          output: "Mem: 1.8Gi used, 2.0Gi free",
        }),
      ).toBe(true);
    });
    await act(async () => {
      await send;
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(requests[1]!.toolRounds[0]!.reasoningContent).toBe(
      "inspect service state before continuing",
    );
    expect(JSON.parse(requests[1]!.toolRounds[0]!.results[0]!.content)).toEqual(
      expect.objectContaining({
        decision: "approved_and_completed",
        exitCode: 0,
        output: "Mem: 1.8Gi used, 2.0Gi free",
      }),
    );
    expect(callbacks.current().messages[1]?.content).toBe(
      "命令执行成功，当前内存状态正常。",
    );
    expect(callbacks.current().messages[1]?.telemetry).toEqual({
      durationMs: 750,
      requestCount: 3,
      usage: {
        cachedInputTokens: 30,
        inputTokens: 300,
        outputTokens: 60,
        reasoningTokens: 15,
        totalTokens: 360,
      },
    });
    expect(result.current.sending).toBe(false);
  });

  test("continues the agent turn with bounded revision feedback after approval is rejected", async () => {
    const requests: Array<{
      toolRounds: Array<{ results: Array<{ content: string }> }>;
    }> = [];
    const invoke = mock(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "ai_task_action_results") {
          const request = args?.request as {
            decisions: Array<{ feedback?: string }>;
          };
          return [
            {
              callId: "command-revision-1",
              content: JSON.stringify({
                decision: "revision_requested",
                feedback: request.decisions[0]?.feedback,
                ok: false,
              }),
              name: "propose_terminal_command",
            },
          ];
        }
        if (command !== "ai_chat_start") {
          throw new Error(`unexpected command: ${command}`);
        }
        const request = args?.request as (typeof requests)[number];
        requests.push(request);
        if (request.toolRounds.length) {
          return {
            content: "已按你的要求调整为只读检查，不会重启服务。",
            toolCalls: [],
          };
        }
        return {
          actionIntents: [
            {
              arguments: {
                command: "systemctl restart nginx",
                purpose: "重启 Nginx",
              },
              expectedEffect: "重启 Nginx 服务",
              id: "command-revision-1",
              reason: "尝试恢复服务",
              risk: "elevated",
              tool: "execute_terminal_command",
            },
          ],
          content: "需要执行一项终端操作。",
          toolCalls: [
            {
              arguments: JSON.stringify({
                command: "systemctl restart nginx",
                purpose: "重启 Nginx",
                risk: "caution",
                risk_reason: "会重启正在运行的服务",
              }),
              id: "command-revision-1",
              name: "propose_terminal_command",
            },
          ],
        };
      },
    ) as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
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

    let send!: Promise<AiConversation | undefined>;
    act(() => {
      send = result.current.sendMessage(baseSendOptions);
    });
    await waitFor(() =>
      expect(callbacks.current().messages[1]?.commandProposals).toHaveLength(1),
    );

    act(() => {
      expect(
        result.current.decideCommandProposal("command-revision-1", {
          feedback: "不要重启服务，只检查当前状态",
          kind: "revision_requested",
        }),
      ).toBe(true);
    });
    await act(async () => {
      await send;
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(JSON.parse(requests[1]!.toolRounds[0]!.results[0]!.content)).toEqual(
      expect.objectContaining({
        decision: "revision_requested",
        feedback: "不要重启服务，只检查当前状态",
        ok: false,
      }),
    );
    expect(callbacks.current().messages[1]).toEqual(
      expect.objectContaining({
        content: "已按你的要求调整为只读检查，不会重启服务。",
        failed: false,
      }),
    );
    expect(result.current.sending).toBe(false);
  });

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
    let onTask: Parameters<AiTaskListener>[0] = () => undefined;
    const listenToTaskEvents = mock(async (callback: typeof onTask) => {
      onTask = callback;
      return () => undefined;
    }) as AiTaskListener;
    const callbacks = createConversationCallbacks();
    const persistConversation = mock(async () => undefined);
    const setDraft = mock(() => undefined);
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        approvalMode: "auto_safe",
        invoke,
        listenToStream,
        listenToTaskEvents,
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
      task: {
        approvalMode: string;
        conversationId: string;
        contextCapturedAt: number;
        contextVersion: number;
        currentDirectory: string;
        fileOperationDirectory?: string;
        hostId: string;
        id: string;
        objective: string;
        terminalSessionId: string;
        writableFiles: Array<{ content: string; path: string; size: number }>;
      };
    };
    expect(request.enabledTools).toEqual(aiSettings.aiReadOnlyTools);
    expect(request.fileEditEnabled).toBe(false);
    expect(request.commandProposalEnabled).toBe(true);
    expect(request.task).toEqual({
      approvalMode: "auto_safe",
      conversationId: "conversation-1",
      contextCapturedAt: expect.any(Number),
      contextVersion: 1,
      currentDirectory: "/root",
      fileOperationDirectory: undefined,
      hostId: "host-1",
      id: request.requestId,
      objective: "检查系统状态",
      terminalSessionId: "session-1",
      writableFiles: [],
    });
    expect(callbacks.current().messages[1]?.taskId).toBe(request.requestId);

    const runningTask = agentTask(request.requestId);
    act(() => {
      onTask({
        kind: "model_turn_started",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 2,
        task: runningTask,
      });
      onTask({
        kind: "model_turn_started",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 99,
        task: { ...runningTask, id: "obsolete-request" },
      });
    });
    expect(result.current.activeTask).toEqual(runningTask);

    act(() => {
      onStream({
        delta: "检查服务器指标",
        kind: "reasoning",
        requestId: request.requestId,
      });
      onStream({ delta: "正在分析", requestId: request.requestId });
      onStream({ delta: "忽略", requestId: "obsolete-request" });
    });
    expect(callbacks.current().messages[1]?.reasoning).toBe("检查服务器指标");
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

  test("restores a task snapshot and ignores older events", async () => {
    const restoredTask = agentTask("task-restored", "completed", 5);
    const replayedTask = agentTask("task-restored", "failed", 6);
    const invoke = mock(async (command: string) => {
      if (command === "ai_task_sync") {
        return {
          task: restoredTask,
          events: [{
          kind: "task_failed",
          protocolVersion: PROTOCOL_VERSION,
          sequence: 6,
          task: replayedTask,
          }],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    }) as unknown as AiRequestInvoke;
    let onTask: Parameters<AiTaskListener>[0] = () => undefined;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        invoke,
        listenToStream: async () => () => undefined,
        listenToTaskEvents: async (callback) => {
          onTask = callback;
          return () => undefined;
        },
        persistConversation: async () => undefined,
        restoreTaskId: "task-restored",
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await waitFor(() => expect(result.current.activeTask).toEqual(replayedTask));
    act(() => {
      onTask({
        kind: "model_turn_started",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 4,
        task: agentTask("task-restored", "running", 4),
      });
    });
    expect(result.current.activeTask).toEqual(replayedTask);
  });

  test("drops a restored task when the terminal session changes", async () => {
    const restoredTask = agentTask("task-restored", "paused", 5);
    const invoke = mock(async (command: string) => {
      if (command === "ai_task_sync") {
        return { task: restoredTask, events: [] };
      }
      throw new Error(`unexpected command: ${command}`);
    }) as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useAiRequestOrchestrator({
          invoke,
          listenToStream: async () => () => undefined,
          listenToTaskEvents: async () => () => undefined,
          persistConversation: async () => undefined,
          restoreTaskId: "task-restored",
          sessionId,
          settings: aiSettings,
          setDraft: () => undefined,
          updateConversation: callbacks.updateConversation,
          updateMessages: callbacks.updateMessages,
        }),
      { initialProps: { sessionId: "session-1" } },
    );

    await waitFor(() => expect(result.current.activeTask).toEqual(restoredTask));
    rerender({ sessionId: "session-2" });
    await waitFor(() => expect(result.current.activeTask).toBeUndefined());
  });

  test("resolves an interrupted task and keeps the recovery prompt internal", async () => {
    let chatRequest: Record<string, unknown> | undefined;
    const invokeMock = mock(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "ai_task_recovery_decide") {
          return {
            completedActions: [],
            decision: "continue_analysis",
            hostId: "host-1",
            interruptionReason: "应用重启",
            objective: "检查系统状态",
            previousTaskId: "task-restored",
            uncertainActions: [],
          };
        }
        if (command === "ai_chat_start") {
          chatRequest = args?.request as Record<string, unknown>;
          return { content: "继续完成", toolCalls: [] };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        invoke: invokeMock as unknown as AiRequestInvoke,
        listenToStream: async () => () => undefined,
        listenToTaskEvents: async () => () => undefined,
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );

    await act(async () => {
      const recovery = await result.current.resolveTaskInterruption(
        "task-restored",
        "continue_analysis",
      );
      expect(recovery.previousTaskId).toBe("task-restored");
      await result.current.sendMessage({
        ...baseSendOptions,
        requestValue: "内部恢复上下文",
        value: "继续分析",
      });
    });

    expect(callbacks.current().messages[0]?.content).toBe("继续分析");
    expect(chatRequest?.messages).toEqual([
      { content: "内部恢复上下文", role: "user" },
    ]);
    expect(
      (chatRequest?.task as { objective?: string } | undefined)?.objective,
    ).toBe("内部恢复上下文");
  });

  test("renders backend diagnostic plans and sends approval decisions to Rust", async () => {
    const response = deferred<AiChatResult>();
    const invokeMock = mock(
      async (command: string, _args?: Record<string, unknown>) =>
        command === "ai_chat_start" ? response.promise : undefined,
    );
    const invoke = invokeMock as unknown as AiRequestInvoke;
    let onTask: Parameters<AiTaskListener>[0] = () => undefined;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
        invoke,
        listenToStream: async () => () => undefined,
        listenToTaskEvents: async (callback) => {
          onTask = callback;
          return () => undefined;
        },
        persistConversation: async () => undefined,
        sessionId: "session-1",
        settings: aiSettings,
        setDraft: () => undefined,
        updateConversation: callbacks.updateConversation,
        updateMessages: callbacks.updateMessages,
      }),
    );
    let send!: Promise<AiConversation | undefined>;
    act(() => {
      send = result.current.sendMessage(baseSendOptions);
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const request = invokeMock.mock.calls[0]?.[1]?.request as {
      requestId: string;
    };
    const plan: AgentPlan = {
      createdAt: Date.now(),
      description: "检查网络",
      id: "plan-backend-1",
      status: "pending",
      steps: [
        {
          dependsOn: [],
          detail: "example.com",
          durationMs: null,
          error: null,
          id: "call-ping",
          optional: false,
          reason: "检查连通性",
          startedAt: null,
          status: "pending",
          summary: "确认计划即授权执行此主动网络探测",
          title: "Ping",
          tool: "ping_target",
        },
      ],
    };
    act(() => {
      onTask({
        kind: "plan_created",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 3,
        task: {
          ...agentTask(request.requestId, "awaiting_approval", 3),
          plan,
        },
      });
    });
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[0]).toMatchObject({
      id: plan.id,
      status: "pending",
    });
    expect(callbacks.current().messages[1]?.toolRuns?.[0]).toMatchObject({
      callId: "call-ping",
      status: "pending",
    });

    act(() => {
      result.current.confirmDiagnosticPlan(plan.id, ["call-ping"]);
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("ai_task_plan_decide", {
        request: {
          decision: "approve",
          planId: plan.id,
          selectedCallIds: ["call-ping"],
          taskId: request.requestId,
        },
      }),
    );
    await act(async () => {
      response.resolve({
        content: "网络正常",
        diagnosticPlans: [
          {
            ...plan,
            status: "completed",
            steps: plan.steps.map((step) => ({
              ...step,
              durationMs: 20,
              status: "completed",
              summary: "Ping example.com：可达",
            })),
          },
        ],
        diagnosticToolRounds: [],
        toolCalls: [],
      });
      await send;
    });
    expect(callbacks.current().messages[1]?.diagnosticPlans?.[0]?.status).toBe(
      "completed",
    );
  });

  test("blocks a duplicate send while the first request is active", async () => {
    const response = deferred<AiChatResult>();
    const invoke = mock(async () => response.promise) as unknown as AiRequestInvoke;
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
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

  test("rejects diagnostic calls left unhandled by the backend", async () => {
    const invokeMock = mock(async (command: string) => {
      if (command !== "ai_chat_start") {
        throw new Error(`不应由前端执行：${command}`);
      }
      return {
        content: "",
        toolCalls: [{
          arguments: "{}",
          id: "call-status",
          name: "get_server_status",
        }],
      };
    });
    const callbacks = createConversationCallbacks();
    const { result } = renderHook(() =>
      useAiRequestOrchestrator({
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

    await act(async () => {
      await result.current.sendMessage(baseSendOptions);
    });

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "ai_chat_start",
    ]);
    expect(callbacks.current().messages[1]).toEqual(
      expect.objectContaining({
        failed: true,
        error: "AI 后端返回了未处理的工具调用：get_server_status",
      }),
    );
  });
});
