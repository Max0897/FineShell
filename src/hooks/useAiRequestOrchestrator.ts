import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../app-settings";
import {
  aiCommandProposalToolResult,
  createAiCommandProposal,
  isAiCommandProposalToolCall,
  type AiCommandProposal,
} from "../ai-command-proposals";
import { aiConversationTitleFromPrompt } from "../ai-conversations";
import {
  aiFileEditToolResult,
  createAiFileEditProposal,
  isAiFileEditToolCall,
  type AiFileEditProposal,
} from "../ai-file-edits";
import {
  aiFileOperationToolResult,
  createAiFileOperationProposal,
  isAiFileOperationToolCall,
  type AiFileOperationProposal,
} from "../ai-file-operations";
import {
  MAX_AI_TOOL_ROUNDS,
  aiToolCallFromRun,
  aiToolResult,
  aiToolResultSummary,
  aiToolTarget,
  createAiToolRun,
  currentDirectoryToolValue,
  finishAiToolRun,
  isAiReadOnlyToolName,
  networkConnectionsToolValue,
  pingToolValue,
  processListToolValue,
  restartAiToolRun,
  serverStatusToolValue,
  traceRouteToolValue,
  type AiToolRun,
} from "../ai-tools";
import { buildAiRequestMessages, type AiRemoteFileContext } from "../ai-utils";
import { diagnosticInvoke } from "../diagnostics";
import type {
  NetworkConnectionsResult,
  NetworkPingResult,
  NetworkTraceResult,
  ServerMonitorSnapshot,
  ServerProcessListResult,
} from "../models";
import {
  commandErrorMessage,
  FineShellCommandError,
  listenProtocolEvent,
  type AiChatResult,
  type AiToolCall,
  type AiToolResult,
  type AiToolRound,
  type TauriCommand,
} from "../tauri-protocol";
import type { AiConversation, AiMessage } from "./useAiConversations";

export type AiRequestInvoke = <T>(
  command: TauriCommand,
  args?: Record<string, unknown>,
) => Promise<T>;

export type AiStreamListener = (
  callback: (payload: { delta: string; requestId: string }) => void,
) => Promise<() => void>;

interface SendAiMessageOptions {
  commandProposalEnabled: boolean;
  context: string;
  contextLabels: string[];
  currentOperationDirectory: string | null;
  editableFiles: AiRemoteFileContext[];
  history: AiMessage[];
  targetConversationId: string;
  targetDirectory: string | null;
  targetHostId: string;
  targetSessionId: string;
  toolCurrentDirectory: string | null;
  value: string;
}

interface RerunAiToolOptions {
  conversationId: string;
  currentDirectory: string | null;
  hostId: string;
  messageId: string;
  run: AiToolRun;
  sessionId: string;
}

interface UseAiRequestOrchestratorOptions {
  confirmToolExecution: (call: AiToolCall) => Promise<boolean>;
  invoke?: AiRequestInvoke;
  listenToStream?: AiStreamListener;
  onCancelError?: (error: unknown) => void;
  onMissingModel?: () => void;
  persistConversation: (conversation?: AiConversation) => Promise<void>;
  sessionId: string | null;
  settings: Pick<
    AppSettings,
    "aiBaseUrl" | "aiModel" | "aiToolsEnabled"
  >;
  setDraft: (conversationId: string, value: string) => void;
  updateConversation: (
    hostId: string,
    conversationId: string,
    update: (conversation: AiConversation) => AiConversation,
  ) => AiConversation | undefined;
  updateMessages: (
    hostId: string,
    conversationId: string,
    update: (messages: AiMessage[]) => AiMessage[],
  ) => AiConversation | undefined;
}

interface ActiveAiRequest {
  assistantId: string;
  conversationId: string;
  hostId: string;
  requestId: string;
}

const defaultInvoke: AiRequestInvoke = (command, args) =>
  diagnosticInvoke(command, args);

const defaultStreamListener: AiStreamListener = (callback) =>
  listenProtocolEvent("ai-stream", ({ payload }) => callback(payload));

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function executeAiReadOnlyTool(
  call: AiToolCall,
  sessionId: string,
  currentDirectory: string | null,
  invoke: AiRequestInvoke = defaultInvoke,
): Promise<AiToolResult> {
  if (!isAiReadOnlyToolName(call.name)) {
    throw new Error(`AI 请求了不支持的工具：${call.name}`);
  }
  switch (call.name) {
    case "get_server_status": {
      const snapshot = await invoke<ServerMonitorSnapshot>(
        "ssh_monitor_snapshot",
        { sessionId },
      );
      return aiToolResult(call, serverStatusToolValue(snapshot));
    }
    case "list_processes": {
      const result = await invoke<ServerProcessListResult>("ssh_processes", {
        sessionId,
      });
      return aiToolResult(call, processListToolValue(result));
    }
    case "get_current_directory": {
      const value = currentDirectoryToolValue(currentDirectory ?? "");
      if (!value.ok) throw new Error(value.error);
      return aiToolResult(call, value);
    }
    case "get_network_connections": {
      const result = await invoke<NetworkConnectionsResult>(
        "ssh_network_connections",
        { sessionId },
      );
      return aiToolResult(call, networkConnectionsToolValue(result));
    }
    case "ping_target": {
      const target = aiToolTarget(call);
      if (!target) throw new Error("AI 未提供 Ping 目标");
      const result = await invoke<NetworkPingResult>("ssh_ping", {
        sessionId,
        target,
      });
      return aiToolResult(call, pingToolValue(result));
    }
    case "trace_route": {
      const target = aiToolTarget(call);
      if (!target) throw new Error("AI 未提供路由追踪目标");
      const result = await invoke<NetworkTraceResult>("ssh_trace_route", {
        sessionId,
        target,
      });
      return aiToolResult(call, traceRouteToolValue(result));
    }
  }
}

export function useAiRequestOrchestrator({
  confirmToolExecution,
  invoke = defaultInvoke,
  listenToStream = defaultStreamListener,
  onCancelError,
  onMissingModel,
  persistConversation,
  sessionId,
  settings,
  setDraft,
  updateConversation,
  updateMessages,
}: UseAiRequestOrchestratorOptions) {
  const [sending, setSending] = useState(false);
  const activeRequestRef = useRef<ActiveAiRequest>();
  const cancelledRequestsRef = useRef(new Set<string>());
  const callbacksRef = useRef({
    onCancelError,
    onMissingModel,
    updateMessages,
  });
  callbacksRef.current = { onCancelError, onMissingModel, updateMessages };

  const cancelRequest = useCallback(async () => {
    const requestId = activeRequestRef.current?.requestId;
    if (!requestId) return;
    cancelledRequestsRef.current.add(requestId);
    try {
      await invoke("ai_chat_cancel", { requestId });
    } catch (error) {
      callbacksRef.current.onCancelError?.(error);
    }
  }, [invoke]);

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (activeRequest) {
      cancelledRequestsRef.current.add(activeRequest.requestId);
      void invoke("ai_chat_cancel", {
        requestId: activeRequest.requestId,
      }).catch(() => undefined);
    }
    activeRequestRef.current = undefined;
    setSending(false);
  }, [invoke, sessionId]);

  useEffect(() => {
    let disposed = false;
    let stopStream: (() => void) | undefined;
    void listenToStream((payload) => {
      const activeRequest = activeRequestRef.current;
      if (!activeRequest || payload.requestId !== activeRequest.requestId) return;
      callbacksRef.current.updateMessages(
        activeRequest.hostId,
        activeRequest.conversationId,
        (current) =>
          current.map((message) =>
            message.id === activeRequest.assistantId
              ? { ...message, content: message.content + payload.delta }
              : message,
          ),
      );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopStream = unlisten;
    });
    return () => {
      disposed = true;
      stopStream?.();
    };
  }, [listenToStream]);

  const sendMessage = useCallback(
    async ({
      commandProposalEnabled,
      context,
      contextLabels,
      currentOperationDirectory,
      editableFiles,
      history,
      targetConversationId,
      targetDirectory,
      targetHostId,
      targetSessionId,
      toolCurrentDirectory,
      value,
    }: SendAiMessageOptions) => {
      if (activeRequestRef.current || !value.trim()) return undefined;
      if (!settings.aiModel.trim()) {
        callbacksRef.current.onMissingModel?.();
        return undefined;
      }

      const requestId = createId("ai-request");
      const userMessage: AiMessage = {
        id: createId("ai-user"),
        role: "user",
        content: value.trim(),
        context: context || undefined,
        contextLabels,
      };
      const assistantMessage: AiMessage = {
        id: createId("ai-assistant"),
        role: "assistant",
        content: "",
      };
      activeRequestRef.current = {
        assistantId: assistantMessage.id,
        conversationId: targetConversationId,
        hostId: targetHostId,
        requestId,
      };
      updateConversation(targetHostId, targetConversationId, (current) => ({
        ...current,
        title:
          current.messages.length === 0 && current.title === "新对话"
            ? aiConversationTitleFromPrompt(userMessage.content)
            : current.title,
        updatedAt: new Date().toISOString(),
        messages: [...history, userMessage, assistantMessage],
      }));
      setDraft(targetConversationId, "");
      setSending(true);
      cancelledRequestsRef.current.delete(requestId);

      try {
        const requestMessages = [
          ...buildAiRequestMessages(history),
          { role: "user" as const, content: userMessage.content },
        ];
        const toolRounds: AiToolRound[] = [];
        const responseParts: string[] = [];
        const proposedFilePaths = new Set<string>();
        const proposedCommands = new Set<string>();
        let completed: AiConversation | undefined;

        for (;;) {
          if (cancelledRequestsRef.current.has(requestId)) {
            throw new Error("AI 请求已取消");
          }
          const result = await invoke<AiChatResult>("ai_chat_start", {
            request: {
              requestId,
              baseUrl: settings.aiBaseUrl,
              model: settings.aiModel,
              messages: requestMessages,
              context: context || null,
              toolsEnabled: settings.aiToolsEnabled,
              fileEditEnabled:
                editableFiles.length > 0 || Boolean(currentOperationDirectory),
              commandProposalEnabled,
              toolRounds,
            },
          });
          if (result.content.trim()) responseParts.push(result.content.trim());

          if (!result.toolCalls.length) {
            completed = updateMessages(
              targetHostId,
              targetConversationId,
              (current) =>
                current.map((message) =>
                  message.id === assistantMessage.id
                    ? {
                        ...message,
                        content: responseParts.join("\n\n"),
                        error: undefined,
                        failed: false,
                      }
                    : message,
                ),
            );
            break;
          }
          if (toolRounds.length >= MAX_AI_TOOL_ROUNDS) {
            throw new Error("AI 连续请求工具次数过多，请缩小问题范围后重试");
          }

          const nextRuns = result.toolCalls
            .filter(
              (call) =>
                !isAiFileEditToolCall(call) &&
                !isAiFileOperationToolCall(call) &&
                !isAiCommandProposalToolCall(call),
            )
            .map(createAiToolRun);
          const nextProposals: AiFileEditProposal[] = [];
          const nextOperationProposals: AiFileOperationProposal[] = [];
          const nextCommandProposals: AiCommandProposal[] = [];
          const proposalResults = new Map<string, AiToolResult>();

          for (const call of result.toolCalls.filter(isAiFileEditToolCall)) {
            let proposalError: string | undefined;
            try {
              if (!editableFiles.length) {
                throw new Error("当前文件上下文不允许生成可应用的修改");
              }
              const proposal = createAiFileEditProposal(
                call,
                editableFiles,
                targetSessionId,
              );
              if (proposedFilePaths.has(proposal.originalFile.path)) {
                throw new Error("AI 重复返回了同一文件的修改建议");
              }
              proposedFilePaths.add(proposal.originalFile.path);
              nextProposals.push(proposal);
            } catch (error) {
              proposalError = commandErrorMessage(error);
            }
            proposalResults.set(
              call.id,
              aiFileEditToolResult(call, proposalError),
            );
          }
          for (const call of result.toolCalls.filter(isAiFileOperationToolCall)) {
            let proposalError: string | undefined;
            try {
              const proposal = createAiFileOperationProposal(
                call,
                editableFiles,
                currentOperationDirectory,
                targetSessionId,
              );
              const touchedPaths = [proposal.path, proposal.targetPath].filter(
                (path): path is string => Boolean(path),
              );
              if (touchedPaths.some((path) => proposedFilePaths.has(path))) {
                throw new Error("AI 返回了相互冲突的文件变更建议");
              }
              touchedPaths.forEach((path) => proposedFilePaths.add(path));
              nextOperationProposals.push(proposal);
            } catch (error) {
              proposalError = commandErrorMessage(error);
            }
            proposalResults.set(
              call.id,
              aiFileOperationToolResult(call, proposalError),
            );
          }
          for (const call of result.toolCalls.filter(isAiCommandProposalToolCall)) {
            let proposalError: string | undefined;
            try {
              if (!commandProposalEnabled) {
                throw new Error("当前终端会话不允许填入命令");
              }
              const proposal = createAiCommandProposal(
                call,
                targetSessionId,
                targetDirectory,
              );
              if (proposedCommands.has(proposal.command)) {
                throw new Error("AI 重复返回了同一条终端命令");
              }
              proposedCommands.add(proposal.command);
              nextCommandProposals.push(proposal);
            } catch (error) {
              proposalError = commandErrorMessage(error);
            }
            proposalResults.set(
              call.id,
              aiCommandProposalToolResult(call, proposalError),
            );
          }
          updateMessages(targetHostId, targetConversationId, (current) =>
            current.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    content: responseParts.join("\n\n"),
                    fileEditProposals: [
                      ...(message.fileEditProposals ?? []),
                      ...nextProposals,
                    ],
                    fileOperationProposals: [
                      ...(message.fileOperationProposals ?? []),
                      ...nextOperationProposals,
                    ],
                    commandProposals: [
                      ...(message.commandProposals ?? []),
                      ...nextCommandProposals,
                    ],
                    toolRuns: [...(message.toolRuns ?? []), ...nextRuns],
                  }
                : message,
            ),
          );

          const toolResults: AiToolResult[] = [];
          for (const call of result.toolCalls) {
            if (cancelledRequestsRef.current.has(requestId)) {
              throw new Error("AI 请求已取消");
            }
            if (isAiFileEditToolCall(call)) {
              toolResults.push(
                proposalResults.get(call.id) ??
                  aiFileEditToolResult(call, "文件修改建议未通过本地校验"),
              );
              continue;
            }
            if (isAiFileOperationToolCall(call)) {
              toolResults.push(
                proposalResults.get(call.id) ??
                  aiFileOperationToolResult(
                    call,
                    "文件操作建议未通过本地校验",
                  ),
              );
              continue;
            }
            if (isAiCommandProposalToolCall(call)) {
              toolResults.push(
                proposalResults.get(call.id) ??
                  aiCommandProposalToolResult(
                    call,
                    "终端命令建议未通过本地校验",
                  ),
              );
              continue;
            }
            let toolResult: AiToolResult;
            let toolError: string | undefined;
            let toolStatus: "success" | "failed" | "cancelled" = "success";
            const allowed = await confirmToolExecution(call);
            if (cancelledRequestsRef.current.has(requestId)) {
              throw new Error("AI 请求已取消");
            }
            if (!allowed) {
              toolError = "用户未授权主动网络探测";
              toolStatus = "cancelled";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else {
              try {
                toolResult = await executeAiReadOnlyTool(
                  call,
                  targetSessionId,
                  toolCurrentDirectory,
                  invoke,
                );
              } catch (error) {
                toolError = commandErrorMessage(error);
                toolStatus = "failed";
                toolResult = aiToolResult(call, {
                  ok: false,
                  error: toolError,
                });
              }
            }
            const toolSummary = aiToolResultSummary(call, toolResult);
            toolResults.push(toolResult);
            updateMessages(targetHostId, targetConversationId, (current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? {
                      ...message,
                      toolRuns: message.toolRuns?.map((run) =>
                        run.callId === call.id
                          ? finishAiToolRun(run, {
                              error: toolError,
                              status: toolStatus,
                              summary: toolSummary,
                            })
                          : run,
                      ),
                    }
                  : message,
              ),
            );
          }
          toolRounds.push({
            calls: result.toolCalls,
            content: result.content.trim() || undefined,
            results: toolResults,
          });
        }
        await persistConversation(completed);
        return completed;
      } catch (error) {
        const cancelled =
          cancelledRequestsRef.current.has(requestId) ||
          (error instanceof FineShellCommandError && error.code === "cancelled");
        updateMessages(targetHostId, targetConversationId, (current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  failed: true,
                  error: cancelled ? "已停止生成" : commandErrorMessage(error),
                  toolRuns: message.toolRuns?.map((run) =>
                    run.status === "running"
                      ? finishAiToolRun(run, {
                          error: cancelled ? "已停止" : "调用未完成",
                          status: cancelled ? "cancelled" : "failed",
                          summary: cancelled
                            ? "用户已停止生成"
                            : "调用未完成",
                        })
                      : run,
                  ),
                }
              : message,
          ),
        );
        return undefined;
      } finally {
        cancelledRequestsRef.current.delete(requestId);
        if (activeRequestRef.current?.requestId === requestId) {
          activeRequestRef.current = undefined;
          setSending(false);
        }
      }
    },
    [
      confirmToolExecution,
      invoke,
      persistConversation,
      setDraft,
      settings.aiBaseUrl,
      settings.aiModel,
      settings.aiToolsEnabled,
      updateConversation,
      updateMessages,
    ],
  );

  const rerunTool = useCallback(
    async ({
      conversationId,
      currentDirectory,
      hostId,
      messageId,
      run,
      sessionId: targetSessionId,
    }: RerunAiToolOptions) => {
      if (activeRequestRef.current) return;
      const call = aiToolCallFromRun(run);
      if (!(await confirmToolExecution(call))) return;
      updateMessages(hostId, conversationId, (current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                toolRuns: message.toolRuns?.map((item) =>
                  item.callId === run.callId ? restartAiToolRun(item) : item,
                ),
              }
            : message,
        ),
      );
      let completion: Parameters<typeof finishAiToolRun>[1];
      try {
        const result = await executeAiReadOnlyTool(
          call,
          targetSessionId,
          currentDirectory,
          invoke,
        );
        completion = { summary: aiToolResultSummary(call, result) };
      } catch (error) {
        const message = commandErrorMessage(error);
        completion = { error: message, summary: message, status: "failed" };
      }
      const updated = updateMessages(hostId, conversationId, (current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                toolRuns: message.toolRuns?.map((item) =>
                  item.callId === run.callId
                    ? finishAiToolRun(item, completion)
                    : item,
                ),
              }
            : message,
        ),
      );
      await persistConversation(updated);
    },
    [
      confirmToolExecution,
      invoke,
      persistConversation,
      updateMessages,
    ],
  );

  return { cancelRequest, rerunTool, sendMessage, sending };
}
