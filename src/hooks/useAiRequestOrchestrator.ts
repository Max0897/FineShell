import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../app-settings";
import { validateAiActionIntents } from "../ai-action-intents";
import { completeAiDiagnosticPlan } from "../ai-diagnostic-plans";
import {
  aiConversationTitleFromPrompt,
  type AiConversationSummaryRecord,
} from "../ai-conversations";
import {
  buildAiConversationRequestMessages,
} from "../ai-summaries";
import { finishAiToolRun } from "../ai-tools";
import type { AiRemoteFileContext } from "../ai-utils";
import { diagnosticInvoke } from "../diagnostics";
import {
  commandErrorMessage,
  FineShellCommandError,
  listenProtocolEvent,
  type AgentApprovalMode,
  type AgentTask,
  type AgentTaskEventPayload,
  type AgentTaskRecoveryContext,
  type AgentTaskRecoveryDecision,
  type AiChatResult,
  type AiRequestTelemetry,
  type AiStreamPayload,
  type AiToolRound,
  type TauriCommand,
} from "../tauri-protocol";
import type { AiConversation, AiMessage } from "./useAiConversations";
import {
  agentTaskIsTerminal,
  mergeAgentPlanIntoMessage,
} from "./ai-agent-plan-presentation";
import {
  aiProposalRoundHasPendingApprovals,
  prepareAiProposalRound,
  resolveAiProposalRound,
} from "./ai-proposal-round";
import { createAiRequestId } from "./ai-request-id";
import { useAiConversationSummaryQueue } from "./useAiConversationSummaryQueue";
import { useAiProposalApprovals } from "./useAiProposalApprovals";

export type AiRequestInvoke = <T>(
  command: TauriCommand,
  args?: Record<string, unknown>,
) => Promise<T>;

export type AiStreamListener = (
  callback: (payload: AiStreamPayload) => void,
) => Promise<() => void>;

export type AiTaskListener = (
  callback: (payload: AgentTaskEventPayload) => void,
) => Promise<() => void>;

interface SendAiMessageOptions {
  approvalModeOverride?: AgentApprovalMode;
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
  requestValue?: string;
}

interface UseAiRequestOrchestratorOptions {
  approvalMode?: AgentApprovalMode;
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

function addSafeIntegers(left: number, right: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function mergeAiRequestTelemetry(
  current: AiRequestTelemetry | undefined,
  next: AiRequestTelemetry | undefined,
): AiRequestTelemetry | undefined {
  if (!next) return current;
  if (!current) return next;
  const usage =
    current.usage || next.usage
      ? {
          cachedInputTokens: addSafeIntegers(
            current.usage?.cachedInputTokens ?? 0,
            next.usage?.cachedInputTokens ?? 0,
          ),
          inputTokens: addSafeIntegers(
            current.usage?.inputTokens ?? 0,
            next.usage?.inputTokens ?? 0,
          ),
          outputTokens: addSafeIntegers(
            current.usage?.outputTokens ?? 0,
            next.usage?.outputTokens ?? 0,
          ),
          reasoningTokens: addSafeIntegers(
            current.usage?.reasoningTokens ?? 0,
            next.usage?.reasoningTokens ?? 0,
          ),
          totalTokens: addSafeIntegers(
            current.usage?.totalTokens ?? 0,
            next.usage?.totalTokens ?? 0,
          ),
        }
      : undefined;
  return {
    durationMs: addSafeIntegers(current.durationMs, next.durationMs),
    requestCount: addSafeIntegers(current.requestCount, next.requestCount),
    usage,
  };
}

export function useAiRequestOrchestrator({
  approvalMode = "on_request",
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
  const activeRequestRef = useRef<ActiveAiRequest>();
  const trackedTaskIdRef = useRef<string>();
  const cancelledRequestsRef = useRef(new Set<string>());
  const activeDiagnosticPlansRef = useRef(
    new Map<string, ActiveDiagnosticPlanLocation>(),
  );
  const backendDiagnosticPlanTasksRef = useRef(new Map<string, string>());
  const stoppedDiagnosticPlansRef = useRef(new Set<string>());
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
  const { queueConversationSummary, summarizingConversationIds } =
    useAiConversationSummaryQueue({
      invoke,
      onSummaryError,
      persistConversation,
      settings,
      updateConversation,
    });
  const {
    decideCommandProposal,
    decideFileProposal,
    rejectPendingCommandApprovals,
    rejectPendingFileApprovals,
    waitForCommandApproval,
    waitForFileApproval,
  } = useAiProposalApprovals();

  const cancelRequest = useCallback(async () => {
    const requestId = activeRequestRef.current?.requestId;
    if (!requestId) return;
    cancelledRequestsRef.current.add(requestId);
    rejectPendingCommandApprovals(requestId);
    rejectPendingFileApprovals(requestId);
    try {
      await invoke("ai_chat_cancel", { requestId });
    } catch (error) {
      callbacksRef.current.onCancelError?.(error);
    }
  }, [invoke, rejectPendingCommandApprovals, rejectPendingFileApprovals]);

  const resolveTaskInterruption = useCallback(
    (taskId: string, decision: AgentTaskRecoveryDecision) =>
      invoke<AgentTaskRecoveryContext>("ai_task_recovery_decide", {
        request: { decision, taskId },
      }),
    [invoke],
  );

  const decideDiagnosticPlan = useCallback(
    (
      planId: string,
      decision: "approve" | "reject" | "stop",
      selectedCallIds: string[],
      feedback?: string,
    ) => {
      const taskId = backendDiagnosticPlanTasksRef.current.get(planId);
      if (!taskId) return Promise.resolve();
      return invoke("ai_task_plan_decide", {
        request: {
          taskId,
          planId,
          decision,
          feedback: feedback?.trim() || undefined,
          selectedCallIds,
        },
      }).catch((error) => callbacksRef.current.onCancelError?.(error));
    },
    [invoke],
  );

  const confirmDiagnosticPlan = useCallback(
    (planId: string, selectedCallIds: string[]) =>
      decideDiagnosticPlan(planId, "approve", selectedCallIds),
    [decideDiagnosticPlan],
  );

  const cancelDiagnosticPlan = useCallback(
    (planId: string) => decideDiagnosticPlan(planId, "reject", []),
    [decideDiagnosticPlan],
  );

  const reviseDiagnosticPlan = useCallback(
    (planId: string, feedback: string) =>
      decideDiagnosticPlan(planId, "reject", [], feedback),
    [decideDiagnosticPlan],
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
      rejectPendingCommandApprovals(
        activeRequest.requestId,
        "终端会话已切换，AI 审批已取消",
      );
      rejectPendingFileApprovals(
        activeRequest.requestId,
        "终端会话已切换，AI 审批已取消",
      );
      void invoke("ai_chat_cancel", {
        requestId: activeRequest.requestId,
      }).catch(() => undefined);
    }
    activeRequestRef.current = undefined;
    trackedTaskIdRef.current = undefined;
    activeDiagnosticPlansRef.current.clear();
    backendDiagnosticPlanTasksRef.current.clear();
    stoppedDiagnosticPlansRef.current.clear();
    setActiveTask(undefined);
    setSending(false);
  }, [
    invoke,
    rejectPendingCommandApprovals,
    rejectPendingFileApprovals,
    sessionId,
  ]);

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
              ? payload.kind === "reasoning"
                ? {
                    ...message,
                    reasoning: `${message.reasoning ?? ""}${payload.delta}`,
                  }
                : { ...message, content: message.content + payload.delta }
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

  const sendMessage = useCallback(
    async ({
      commandProposalEnabled,
      approvalModeOverride,
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
      requestValue,
    }: SendAiMessageOptions) => {
      if (activeRequestRef.current || !value.trim()) return undefined;
      if (!settings.aiModel.trim()) {
        callbacksRef.current.onMissingModel?.();
        return undefined;
      }

      const modelRequestValue = requestValue?.trim() || value.trim();
      const requestId = createAiRequestId("ai-request");
      const userMessage: AiMessage = {
        id: createAiRequestId("ai-user"),
        role: "user",
        content: value.trim(),
        context: context || undefined,
        contextLabels,
      };
      const assistantMessage: AiMessage = {
        id: createAiRequestId("ai-assistant"),
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
      let requestTelemetry: AiRequestTelemetry | undefined;

      try {
        const requestMessages = [
          ...buildAiConversationRequestMessages(history, conversationSummary),
          { role: "user" as const, content: modelRequestValue },
        ];
        const toolRounds: AiToolRound[] = [];
        const responseParts: string[] = [];
        const proposedFilePaths = new Set<string>();
        const proposedCommands = new Set<string>();
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
              toolRounds,
              task: {
                contextVersion: 1,
                contextCapturedAt: Date.now(),
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
                objective: modelRequestValue,
                approvalMode: approvalModeOverride ?? approvalMode,
              },
            },
          });
          requestTelemetry = mergeAiRequestTelemetry(
            requestTelemetry,
            result.telemetry,
          );
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
          if (!result.toolCalls.length) {
            if (result.content.trim()) {
              responseParts.push(result.content.trim());
            }
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
                        telemetry: requestTelemetry,
                      }
                    : message,
                ),
            );
            break;
          }
          const proposalRound = prepareAiProposalRound({
            calls: result.toolCalls,
            currentOperationDirectory,
            editableFiles,
            fileProposalEnabled,
            proposedCommands,
            proposedFilePaths,
            requestId,
            targetDirectory,
            targetSessionId,
            terminalProposalEnabled,
            waitForCommandApproval,
            waitForFileApproval,
          });
          const proposalConversation = updateMessages(
            targetHostId,
            targetConversationId,
            (current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? {
                      ...message,
                      content: "",
                      fileEditProposals: [
                        ...(message.fileEditProposals ?? []),
                        ...proposalRound.fileEditProposals,
                      ],
                      fileOperationProposals: [
                        ...(message.fileOperationProposals ?? []),
                        ...proposalRound.fileOperationProposals,
                      ],
                      commandProposals: [
                        ...(message.commandProposals ?? []),
                        ...proposalRound.commandProposals,
                      ],
                    }
                  : message,
              ),
          );
          if (aiProposalRoundHasPendingApprovals(proposalRound)) {
            await persistConversation(proposalConversation);
          }
          const decisions = await resolveAiProposalRound(
            result.toolCalls,
            proposalRound,
            () => cancelledRequestsRef.current.has(requestId),
          );
          const toolResults = await invoke<AiToolRound["results"]>(
            "ai_task_action_results",
            {
              request: {
                taskId: requestId,
                calls: result.toolCalls,
                decisions,
              },
            },
          );
          toolRounds.push({
            calls: result.toolCalls,
            content: result.content.trim() || undefined,
            reasoningContent: result.reasoningContent,
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
        const failedConversation = updateMessages(
          targetHostId,
          targetConversationId,
          (current) =>
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
                      commandProposals: message.commandProposals?.map(
                        (proposal) =>
                          proposal.status === "pending"
                            ? { ...proposal, status: "rejected" as const }
                            : proposal,
                      ),
                      fileEditProposals: message.fileEditProposals?.map(
                        (proposal) =>
                          proposal.status === "pending"
                            ? { ...proposal, status: "rejected" as const }
                            : proposal,
                      ),
                      fileOperationProposals:
                        message.fileOperationProposals?.map((proposal) =>
                          proposal.status === "pending"
                            ? { ...proposal, status: "rejected" as const }
                            : proposal,
                        ),
                      failed: true,
                      telemetry: requestTelemetry,
                      error: cancelled
                        ? "已停止生成"
                        : commandErrorMessage(error),
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
        await persistConversation(failedConversation);
        return undefined;
      } finally {
        rejectPendingCommandApprovals(requestId);
        rejectPendingFileApprovals(requestId);
        cancelledRequestsRef.current.delete(requestId);
        for (const [planId, location] of activeDiagnosticPlansRef.current) {
          if (location.messageId === assistantMessage.id) {
            activeDiagnosticPlansRef.current.delete(planId);
            backendDiagnosticPlanTasksRef.current.delete(planId);
            stoppedDiagnosticPlansRef.current.delete(planId);
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
      invoke,
      persistConversation,
      queueConversationSummary,
      rejectPendingCommandApprovals,
      rejectPendingFileApprovals,
      setDraft,
      settings.aiBaseUrl,
      settings.aiCommandProposalsEnabled,
      settings.aiFileProposalsEnabled,
      settings.aiModel,
      settings.aiReadOnlyTools,
      updateConversation,
      updateMessages,
      waitForCommandApproval,
      waitForFileApproval,
    ],
  );

  return {
    activeTask,
    cancelDiagnosticPlan,
    cancelRequest,
    confirmDiagnosticPlan,
    decideCommandProposal,
    decideFileProposal,
    reviseDiagnosticPlan,
    resolveTaskInterruption,
    sendMessage,
    sending,
    stopDiagnosticPlan,
    summarizingConversationIds,
  };
}
