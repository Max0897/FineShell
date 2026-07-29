import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../app-settings";
import { validateAiActionIntents } from "../ai-action-intents";
import {
  completeAiDiagnosticPlan,
  createAiDiagnosticPlan,
  type AiDiagnosticPlan,
} from "../ai-diagnostic-plans";
import { aiReadOnlyToolEnabled } from "../ai-permissions";
import {
  aiCommandProposalToolResult,
  createAiCommandProposal,
  isAiCommandProposalToolCall,
  type AiCommandProposal,
} from "../ai-command-proposals";
import {
  aiConversationTitleFromPrompt,
  sanitizeAiConversation,
  type AiConversationSummaryRecord,
} from "../ai-conversations";
import {
  buildAiConversationRequestMessages,
  completeAiConversationSummary,
  createAiConversationSummaryPlan,
} from "../ai-summaries";
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
  aiToolLoopFinalizeReason,
  aiToolCallFromRun,
  aiToolResult,
  aiToolResultSummary,
  aiToolTarget,
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
import type { AiRemoteFileContext } from "../ai-utils";
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
  type AgentApprovalMode,
  type AgentPlan,
  type AgentTask,
  type AgentTaskEventPayload,
  type AiChatResult,
  type AiFinalizeReason,
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

export type AiTaskListener = (
  callback: (payload: AgentTaskEventPayload) => void,
) => Promise<() => void>;

interface SendAiMessageOptions {
  commandProposalEnabled: boolean;
  conversationSummary?: AiConversationSummaryRecord;
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
  approvalMode?: AgentApprovalMode;
  confirmToolExecution: (call: AiToolCall) => Promise<boolean>;
  invoke?: AiRequestInvoke;
  listenToStream?: AiStreamListener;
  listenToTaskEvents?: AiTaskListener;
  onCancelError?: (error: unknown) => void;
  onMissingModel?: () => void;
  onSummaryError?: (error: unknown) => void;
  persistConversation: (conversation?: AiConversation) => Promise<void>;
  restoreTaskId?: string;
  sessionId: string | null;
  settings: Pick<
    AppSettings,
    | "aiBaseUrl"
    | "aiModel"
    | "aiReadOnlyTools"
    | "aiFileProposalsEnabled"
    | "aiCommandProposalsEnabled"
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

interface AiDiagnosticPlanDecision {
  selectedCallIds: string[];
  type: "confirm" | "cancel" | "abort";
}

interface ActiveDiagnosticPlanLocation {
  conversationId: string;
  hostId: string;
  messageId: string;
}

const defaultInvoke: AiRequestInvoke = (command, args) =>
  diagnosticInvoke(command, args);

const defaultStreamListener: AiStreamListener = (callback) =>
  listenProtocolEvent("ai-stream", ({ payload }) => callback(payload));

const defaultTaskListener: AiTaskListener = (callback) =>
  listenProtocolEvent("ai-task", ({ payload }) => callback(payload));

function agentTaskIsTerminal(task: AgentTask) {
  return ["completed", "failed", "cancelled"].includes(task.status);
}

function agentPlanPresentation(plan: AgentPlan): {
  plan: AiDiagnosticPlan;
  runs: AiToolRun[];
} {
  const runs = plan.steps
    .filter((step) => isAiReadOnlyToolName(step.tool))
    .map((step): AiToolRun => {
      const status: AiToolRun["status"] =
        step.status === "in_progress"
          ? "running"
          : step.status === "completed"
            ? "success"
            : step.status === "failed"
              ? "failed"
              : step.status === "skipped"
                ? "skipped"
                : "pending";
      return {
        callId: step.id,
        dependsOn: step.dependsOn.length ? step.dependsOn : undefined,
        detail: step.detail ?? undefined,
        durationMs: step.durationMs ?? undefined,
        error: step.error ?? undefined,
        label: step.title,
        name: step.tool as AiToolRun["name"],
        optional: step.optional || undefined,
        planId: plan.id,
        reason: step.reason,
        startedAt: step.startedAt ?? plan.createdAt,
        status,
        summary: step.summary ?? undefined,
      };
    });
  return {
    plan: {
      createdAt: new Date(plan.createdAt).toISOString(),
      description: plan.description ?? undefined,
      id: plan.id,
      status: plan.status,
      stepCallIds: plan.steps.map((step) => step.id),
    },
    runs,
  };
}

function mergeAgentPlanIntoMessage(message: AiMessage, plan: AgentPlan): AiMessage {
  const presentation = agentPlanPresentation(plan);
  const diagnosticPlans = message.diagnosticPlans ?? [];
  const toolRuns = message.toolRuns ?? [];
  const planExists = diagnosticPlans.some((item) => item.id === plan.id);
  const nextPlanCallIds = new Set(presentation.runs.map((run) => run.callId));
  return {
    ...message,
    diagnosticPlans: planExists
      ? diagnosticPlans.map((item) =>
          item.id === plan.id ? presentation.plan : item,
        )
      : [...diagnosticPlans, presentation.plan],
    toolRuns: [
      ...toolRuns.filter((run) => !nextPlanCallIds.has(run.callId)),
      ...presentation.runs,
    ],
  };
}

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
  approvalMode = "on_request",
  confirmToolExecution,
  invoke = defaultInvoke,
  listenToStream = defaultStreamListener,
  listenToTaskEvents = defaultTaskListener,
  onCancelError,
  onMissingModel,
  onSummaryError,
  persistConversation,
  restoreTaskId,
  sessionId,
  settings,
  setDraft,
  updateConversation,
  updateMessages,
}: UseAiRequestOrchestratorOptions) {
  const [sending, setSending] = useState(false);
  const [activeTask, setActiveTask] = useState<AgentTask>();
  const [summarizingConversationIds, setSummarizingConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const activeRequestRef = useRef<ActiveAiRequest>();
  const trackedTaskIdRef = useRef<string>();
  const cancelledRequestsRef = useRef(new Set<string>());
  const diagnosticPlanWaitersRef = useRef(
    new Map<string, (decision: AiDiagnosticPlanDecision) => void>(),
  );
  const activeDiagnosticPlansRef = useRef(
    new Map<string, ActiveDiagnosticPlanLocation>(),
  );
  const backendDiagnosticPlanTasksRef = useRef(new Map<string, string>());
  const stoppedDiagnosticPlansRef = useRef(new Set<string>());
  const summaryRequestsRef = useRef(new Set<string>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const callbacksRef = useRef({
    onCancelError,
    onMissingModel,
    onSummaryError,
    updateMessages,
  });
  callbacksRef.current = {
    onCancelError,
    onMissingModel,
    onSummaryError,
    updateMessages,
  };

  const cancelRequest = useCallback(async () => {
    const requestId = activeRequestRef.current?.requestId;
    if (!requestId) return;
    cancelledRequestsRef.current.add(requestId);
    for (const resolve of diagnosticPlanWaitersRef.current.values()) {
      resolve({ selectedCallIds: [], type: "abort" });
    }
    diagnosticPlanWaitersRef.current.clear();
    try {
      await invoke("ai_chat_cancel", { requestId });
    } catch (error) {
      callbacksRef.current.onCancelError?.(error);
    }
  }, [invoke]);

  const confirmDiagnosticPlan = useCallback(
    (planId: string, selectedCallIds: string[]) => {
      const taskId = backendDiagnosticPlanTasksRef.current.get(planId);
      if (taskId) {
        void invoke("ai_task_plan_decide", {
          request: {
            taskId,
            planId,
            decision: "approve",
            selectedCallIds,
          },
        }).catch((error) => callbacksRef.current.onCancelError?.(error));
        return;
      }
      const resolve = diagnosticPlanWaitersRef.current.get(planId);
      if (!resolve) return;
      diagnosticPlanWaitersRef.current.delete(planId);
      resolve({ selectedCallIds, type: "confirm" });
    },
    [invoke],
  );

  const cancelDiagnosticPlan = useCallback(
    (planId: string) => {
      const taskId = backendDiagnosticPlanTasksRef.current.get(planId);
      if (taskId) {
        void invoke("ai_task_plan_decide", {
          request: {
            taskId,
            planId,
            decision: "reject",
            selectedCallIds: [],
          },
        }).catch((error) => callbacksRef.current.onCancelError?.(error));
        return;
      }
      const resolve = diagnosticPlanWaitersRef.current.get(planId);
      if (!resolve) return;
      diagnosticPlanWaitersRef.current.delete(planId);
      resolve({ selectedCallIds: [], type: "cancel" });
    },
    [invoke],
  );

  const stopDiagnosticPlan = useCallback(
    (planId: string) => {
      stoppedDiagnosticPlansRef.current.add(planId);
      const taskId = backendDiagnosticPlanTasksRef.current.get(planId);
      if (taskId) {
        void invoke("ai_task_plan_decide", {
          request: {
            taskId,
            planId,
            decision: "stop",
            selectedCallIds: [],
          },
        }).catch((error) => callbacksRef.current.onCancelError?.(error));
      }
      const location = activeDiagnosticPlansRef.current.get(planId);
      if (!location) return;
      updateMessages(
        location.hostId,
        location.conversationId,
        (messages) =>
          messages.map((message) =>
            message.id === location.messageId
              ? {
                  ...message,
                  diagnosticPlans: message.diagnosticPlans?.map((plan) =>
                    plan.id === planId
                      ? { ...plan, stopRequested: true }
                      : plan,
                  ),
                }
              : message,
          ),
      );
    },
    [invoke, updateMessages],
  );

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (activeRequest) {
      cancelledRequestsRef.current.add(activeRequest.requestId);
      void invoke("ai_chat_cancel", {
        requestId: activeRequest.requestId,
      }).catch(() => undefined);
    }
    activeRequestRef.current = undefined;
    trackedTaskIdRef.current = undefined;
    for (const resolve of diagnosticPlanWaitersRef.current.values()) {
      resolve({ selectedCallIds: [], type: "abort" });
    }
    diagnosticPlanWaitersRef.current.clear();
    activeDiagnosticPlansRef.current.clear();
    backendDiagnosticPlanTasksRef.current.clear();
    stoppedDiagnosticPlansRef.current.clear();
    setActiveTask(undefined);
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

  useEffect(() => {
    let disposed = false;
    let stopTaskEvents: (() => void) | undefined;
    void listenToTaskEvents((payload) => {
      const activeRequest = activeRequestRef.current;
      const trackedTaskId = activeRequest?.requestId ?? trackedTaskIdRef.current;
      if (!trackedTaskId || payload.task.id !== trackedTaskId) return;
      setActiveTask((current) => {
        if (
          current?.id === payload.task.id &&
          current.lastEventSequence >= payload.sequence
        ) {
          return current;
        }
        return payload.task;
      });
      const plan = payload.task.plan;
      if (plan && activeRequest) {
        backendDiagnosticPlanTasksRef.current.set(plan.id, payload.task.id);
        activeDiagnosticPlansRef.current.set(plan.id, {
          conversationId: activeRequest.conversationId,
          hostId: activeRequest.hostId,
          messageId: activeRequest.assistantId,
        });
        callbacksRef.current.updateMessages(
          activeRequest.hostId,
          activeRequest.conversationId,
          (messages) =>
            messages.map((message) =>
              message.id === activeRequest.assistantId
                ? mergeAgentPlanIntoMessage(message, plan)
                : message,
            ),
        );
        if (["completed", "partial", "cancelled"].includes(plan.status)) {
          activeDiagnosticPlansRef.current.delete(plan.id);
          stoppedDiagnosticPlansRef.current.delete(plan.id);
        }
      }
      if (agentTaskIsTerminal(payload.task)) setSending(false);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopTaskEvents = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stopTaskEvents?.();
    };
  }, [listenToTaskEvents]);

  useEffect(() => {
    if (!restoreTaskId) {
      if (!activeRequestRef.current) {
        trackedTaskIdRef.current = undefined;
        setActiveTask(undefined);
      }
      return;
    }
    trackedTaskIdRef.current = restoreTaskId;
    let disposed = false;
    void invoke<AgentTask | null>("ai_task_get", { taskId: restoreTaskId })
      .then(async (task) => {
        if (!task) return null;
        let replayed: AgentTaskEventPayload[];
        try {
          replayed = await invoke<AgentTaskEventPayload[]>(
            "ai_task_events_since",
            { taskId: task.id, afterSequence: task.lastEventSequence },
          );
        } catch {
          return task;
        }
        return replayed.reduce(
          (latest, event) =>
            event.sequence > latest.lastEventSequence ? event.task : latest,
          task,
        );
      })
      .then((task) => {
        if (disposed || !task || trackedTaskIdRef.current !== task.id) return;
        setActiveTask((current) =>
          current?.id === task.id &&
          current.lastEventSequence > task.lastEventSequence
            ? current
            : task,
        );
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [invoke, restoreTaskId]);

  const queueConversationSummary = useCallback(
    (conversation?: AiConversation) => {
      if (!conversation || summaryRequestsRef.current.has(conversation.id)) {
        return;
      }
      const sanitized = sanitizeAiConversation(conversation);
      if (!sanitized) return;
      const plan = createAiConversationSummaryPlan(sanitized);
      if (!plan) return;

      summaryRequestsRef.current.add(conversation.id);
      setSummarizingConversationIds((current) => {
        const next = new Set(current);
        next.add(conversation.id);
        return next;
      });
      void (async () => {
        try {
          const result = await invoke<AiChatResult>("ai_chat_start", {
            request: {
              requestId: createId("ai-summary"),
              baseUrl: settings.aiBaseUrl,
              model: settings.aiModel,
              messages: [{ role: "user", content: plan.prompt }],
              context: null,
              enabledTools: [],
              fileEditEnabled: false,
              commandProposalEnabled: false,
              toolRounds: [],
            },
          });
          if (result.toolCalls.length) {
            throw new Error("对话摘要请求返回了不支持的工具调用");
          }
          const summary = completeAiConversationSummary(plan, result.content);
          let applied = false;
          const updated = updateConversation(
            conversation.hostId,
            conversation.id,
            (current) => {
              if (
                current.summary?.throughMessageId !==
                plan.previousSummary?.throughMessageId
              ) {
                return current;
              }
              applied = true;
              return { ...current, summary };
            },
          );
          if (applied) await persistConversation(updated);
        } catch (error) {
          callbacksRef.current.onSummaryError?.(error);
        } finally {
          summaryRequestsRef.current.delete(conversation.id);
          setSummarizingConversationIds((current) => {
            const next = new Set(current);
            next.delete(conversation.id);
            return next;
          });
        }
      })();
    }, [
      invoke,
      persistConversation,
      settings.aiBaseUrl,
      settings.aiModel,
      updateConversation,
    ],
  );

  const sendMessage = useCallback(
    async ({
      commandProposalEnabled,
      conversationSummary,
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
        taskId: requestId,
      };
      activeRequestRef.current = {
        assistantId: assistantMessage.id,
        conversationId: targetConversationId,
        hostId: targetHostId,
        requestId,
      };
      trackedTaskIdRef.current = requestId;
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
      setActiveTask(undefined);
      setSending(true);
      cancelledRequestsRef.current.delete(requestId);

      try {
        const requestMessages = [
          ...buildAiConversationRequestMessages(history, conversationSummary),
          { role: "user" as const, content: userMessage.content },
        ];
        const toolRounds: AiToolRound[] = [];
        const responseParts: string[] = [];
        const proposedFilePaths = new Set<string>();
        const proposedCommands = new Set<string>();
        let finalizeReason: AiFinalizeReason | undefined;
        const fileProposalEnabled =
          settings.aiFileProposalsEnabled &&
          (editableFiles.length > 0 || Boolean(currentOperationDirectory));
        const terminalProposalEnabled =
          settings.aiCommandProposalsEnabled && commandProposalEnabled;
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
              enabledTools: settings.aiReadOnlyTools,
              fileEditEnabled: fileProposalEnabled,
              commandProposalEnabled: terminalProposalEnabled,
              finalizeReason,
              toolRounds,
              task: {
                id: requestId,
                conversationId: targetConversationId,
                hostId: targetHostId,
                terminalSessionId: targetSessionId,
                currentDirectory: toolCurrentDirectory ?? undefined,
                fileOperationDirectory: currentOperationDirectory ?? undefined,
                writableFiles: editableFiles.map(({ content, path, size }) => ({
                  content,
                  path,
                  size,
                })),
                objective: userMessage.content,
                approvalMode,
              },
            },
          });
          for (const plan of result.diagnosticPlans ?? []) {
            backendDiagnosticPlanTasksRef.current.set(plan.id, requestId);
            updateMessages(targetHostId, targetConversationId, (current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? mergeAgentPlanIntoMessage(message, plan)
                  : message,
              ),
            );
          }
          toolRounds.push(...(result.diagnosticToolRounds ?? []));
          validateAiActionIntents(
            result.toolCalls,
            result.actionIntents ?? [],
          );
          const diagnosticCalls = result.toolCalls.filter(
            (call) =>
              !isAiFileEditToolCall(call) &&
              !isAiFileOperationToolCall(call) &&
              !isAiCommandProposalToolCall(call),
          );
          if (result.content.trim() && !diagnosticCalls.length) {
            responseParts.push(result.content.trim());
          }

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
          if (finalizeReason) {
            throw new Error("AI 收尾响应返回了意外的工具调用");
          }
          const nextFinalizeReason = aiToolLoopFinalizeReason(
            toolRounds,
            result.toolCalls,
          );
          if (nextFinalizeReason) {
            finalizeReason = nextFinalizeReason;
            continue;
          }

          let nextPlan: AiDiagnosticPlan | undefined;
          let nextRuns: AiToolRun[] = [];
          if (diagnosticCalls.length) {
            const created = createAiDiagnosticPlan(
              createId("ai-diagnostic-plan"),
              diagnosticCalls,
              result.content,
              settingsRef.current.aiReadOnlyTools,
            );
            nextPlan = created.plan;
            nextRuns = created.runs;
          }
          const nextProposals: AiFileEditProposal[] = [];
          const nextOperationProposals: AiFileOperationProposal[] = [];
          const nextCommandProposals: AiCommandProposal[] = [];
          const proposalResults = new Map<string, AiToolResult>();

          for (const call of result.toolCalls.filter(isAiFileEditToolCall)) {
            let proposalError: string | undefined;
            try {
              if (!fileProposalEnabled || !editableFiles.length) {
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
              if (!fileProposalEnabled) {
                throw new Error("文件变更提案权限已关闭");
              }
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
              if (!terminalProposalEnabled) {
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
                    diagnosticPlans: nextPlan
                      ? [...(message.diagnosticPlans ?? []), nextPlan]
                      : message.diagnosticPlans,
                    toolRuns: [...(message.toolRuns ?? []), ...nextRuns],
                  }
                : message,
            ),
          );

          const syncDiagnosticPlan = () => {
            if (!nextPlan) return;
            const displayedPlan = stoppedDiagnosticPlansRef.current.has(
              nextPlan.id,
            )
              ? { ...nextPlan, stopRequested: true }
              : nextPlan;
            const runsById = new Map(
              nextRuns.map((run) => [run.callId, run] as const),
            );
            updateMessages(targetHostId, targetConversationId, (current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? {
                      ...message,
                      diagnosticPlans: message.diagnosticPlans?.map((plan) =>
                        plan.id === displayedPlan.id ? displayedPlan : plan,
                      ),
                      toolRuns: message.toolRuns?.map(
                        (run) => runsById.get(run.callId) ?? run,
                      ),
                    }
                  : message,
              ),
            );
          };

          let planDecision: AiDiagnosticPlanDecision | undefined;
          if (nextPlan) {
            activeDiagnosticPlansRef.current.set(nextPlan.id, {
              conversationId: targetConversationId,
              hostId: targetHostId,
              messageId: assistantMessage.id,
            });
            if (nextRuns.some((run) => run.status === "pending")) {
              planDecision = await new Promise<AiDiagnosticPlanDecision>(
                (resolve) => {
                  diagnosticPlanWaitersRef.current.set(nextPlan!.id, resolve);
                },
              );
            } else {
              planDecision = { selectedCallIds: [], type: "confirm" };
            }
            if (
              planDecision.type === "abort" ||
              cancelledRequestsRef.current.has(requestId)
            ) {
              throw new Error("AI 请求已取消");
            }
            if (planDecision.type === "cancel") {
              nextRuns = nextRuns.map((run) =>
                run.status === "pending"
                  ? finishAiToolRun(
                      { ...run, startedAt: Date.now() },
                      {
                        status: "cancelled",
                        summary: "用户取消了诊断计划",
                      },
                    )
                  : run,
              );
              nextPlan = completeAiDiagnosticPlan(nextPlan, nextRuns);
            } else {
              nextPlan = { ...nextPlan, status: "running" };
            }
            syncDiagnosticPlan();
          }

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
            const runIndex = nextRuns.findIndex(
              (run) => run.callId === call.id,
            );
            const run = nextRuns[runIndex];
            if (!nextPlan || !run || !planDecision) {
              throw new Error(`AI 请求了不支持的工具：${call.name}`);
            }
            let toolResult: AiToolResult;
            let toolError: string | undefined;
            let terminalStatus:
              | "success"
              | "failed"
              | "cancelled"
              | "skipped"
              | "unavailable" = "success";
            const selected =
              !run.optional ||
              planDecision.selectedCallIds.includes(run.callId);
            const dependencyFailed = run.dependsOn?.some(
              (dependencyId) =>
                nextRuns.find((item) => item.callId === dependencyId)?.status !==
                "success",
            );
            if (run.status === "unavailable") {
              toolError = "只读工具权限已关闭";
              terminalStatus = "unavailable";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else if (planDecision.type === "cancel" || !selected) {
              toolError =
                planDecision.type === "cancel"
                  ? "用户取消了诊断计划"
                  : "用户取消了可选诊断步骤";
              terminalStatus = "cancelled";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else if (stoppedDiagnosticPlansRef.current.has(nextPlan.id)) {
              toolError = "用户停止了剩余诊断步骤";
              terminalStatus = "cancelled";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else if (dependencyFailed) {
              toolError = "依赖的诊断步骤未成功，已跳过";
              terminalStatus = "skipped";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else if (
              !aiReadOnlyToolEnabled(
                settingsRef.current.aiReadOnlyTools,
                call.name,
              )
            ) {
              toolError = "只读工具权限已关闭";
              terminalStatus = "unavailable";
              toolResult = aiToolResult(call, { ok: false, error: toolError });
            } else {
              nextRuns[runIndex] = {
                ...run,
                error: undefined,
                startedAt: Date.now(),
                status: "running",
                summary: undefined,
              };
              syncDiagnosticPlan();
              try {
                toolResult = await executeAiReadOnlyTool(
                  call,
                  targetSessionId,
                  toolCurrentDirectory,
                  invoke,
                );
              } catch (error) {
                toolError = commandErrorMessage(error);
                terminalStatus = "failed";
                toolResult = aiToolResult(call, {
                  ok: false,
                  error: toolError,
                });
              }
            }
            const toolSummary = aiToolResultSummary(call, toolResult);
            const currentRun = nextRuns[runIndex]!;
            nextRuns[runIndex] = finishAiToolRun(
              currentRun.status === "running"
                ? currentRun
                : { ...currentRun, startedAt: Date.now() },
              {
                error: toolError,
                status: terminalStatus,
                summary: toolSummary,
              },
            );
            toolResults.push(toolResult);
            syncDiagnosticPlan();
          }
          if (nextPlan) {
            nextPlan = completeAiDiagnosticPlan(nextPlan, nextRuns);
            syncDiagnosticPlan();
            activeDiagnosticPlansRef.current.delete(nextPlan.id);
            stoppedDiagnosticPlansRef.current.delete(nextPlan.id);
          }
          toolRounds.push({
            calls: result.toolCalls,
            content: result.content.trim() || undefined,
            results: toolResults,
          });
        }
        await persistConversation(completed);
        queueConversationSummary(completed);
        return completed;
      } catch (error) {
        const cancelled =
          cancelledRequestsRef.current.has(requestId) ||
          (error instanceof FineShellCommandError && error.code === "cancelled");
        updateMessages(targetHostId, targetConversationId, (current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? (() => {
                  const toolRuns = message.toolRuns?.map((run) =>
                    run.status === "running" || run.status === "pending"
                      ? finishAiToolRun(
                          run.status === "pending"
                            ? { ...run, startedAt: Date.now() }
                            : run,
                          {
                            error: cancelled ? "已停止" : "调用未完成",
                            status: cancelled ? "cancelled" : "failed",
                            summary: cancelled
                              ? "用户已停止生成"
                              : "调用未完成",
                          },
                        )
                      : run,
                  );
                  return {
                    ...message,
                    failed: true,
                    error: cancelled ? "已停止生成" : commandErrorMessage(error),
                    diagnosticPlans: message.diagnosticPlans?.map((plan) =>
                      plan.status === "pending" || plan.status === "running"
                        ? completeAiDiagnosticPlan(plan, toolRuns ?? [])
                        : plan,
                    ),
                    toolRuns,
                  };
                })()
              : message,
          ),
        );
        return undefined;
      } finally {
        cancelledRequestsRef.current.delete(requestId);
        for (const [planId, location] of activeDiagnosticPlansRef.current) {
          if (location.messageId === assistantMessage.id) {
            activeDiagnosticPlansRef.current.delete(planId);
            backendDiagnosticPlanTasksRef.current.delete(planId);
            stoppedDiagnosticPlansRef.current.delete(planId);
            diagnosticPlanWaitersRef.current.delete(planId);
          }
        }
        if (activeRequestRef.current?.requestId === requestId) {
          activeRequestRef.current = undefined;
          setSending(false);
        }
      }
    },
    [
      approvalMode,
      confirmToolExecution,
      invoke,
      persistConversation,
      queueConversationSummary,
      setDraft,
      settings.aiBaseUrl,
      settings.aiCommandProposalsEnabled,
      settings.aiFileProposalsEnabled,
      settings.aiModel,
      settings.aiReadOnlyTools,
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
      if (!aiReadOnlyToolEnabled(settings.aiReadOnlyTools, call.name)) {
        const message = "该只读工具权限已关闭";
        const updated = updateMessages(hostId, conversationId, (current) =>
          current.map((item) =>
            item.id === messageId
              ? {
                  ...item,
                  toolRuns: item.toolRuns?.map((toolRun) =>
                    toolRun.callId === run.callId
                      ? finishAiToolRun(restartAiToolRun(toolRun), {
                          error: message,
                          status: "failed",
                          summary: message,
                        })
                      : toolRun,
                  ),
                }
              : item,
          ),
        );
        await persistConversation(updated);
        return;
      }
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
      settings.aiReadOnlyTools,
      updateMessages,
    ],
  );

  return {
    activeTask,
    cancelDiagnosticPlan,
    cancelRequest,
    confirmDiagnosticPlan,
    rerunTool,
    sendMessage,
    sending,
    stopDiagnosticPlan,
    summarizingConversationIds,
  };
}
