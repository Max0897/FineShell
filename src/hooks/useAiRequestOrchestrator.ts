import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../app-settings";
import { validateAiActionIntents } from "../ai-action-intents";
import {
  completeAiDiagnosticPlan,
  type AiDiagnosticPlan,
} from "../ai-diagnostic-plans";
import {
  aiCommandApprovalToolResult,
  aiCommandProposalToolResult,
  createAiCommandProposal,
  isAiCommandProposalToolCall,
  type AiCommandApprovalDecision,
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
  aiFileApprovalToolResult,
  type AiFileApprovalDecision,
} from "../ai-file-approvals";
import {
  aiFileOperationToolResult,
  createAiFileOperationProposal,
  isAiFileOperationToolCall,
  type AiFileOperationProposal,
} from "../ai-file-operations";
import {
  aiToolLoopFinalizeReason,
  finishAiToolRun,
  isAiReadOnlyToolName,
  type AiToolRun,
} from "../ai-tools";
import type { AiRemoteFileContext } from "../ai-utils";
import { diagnosticInvoke } from "../diagnostics";
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

interface PendingCommandApproval {
  reject: (error: Error) => void;
  requestId: string;
  resolve: (decision: AiCommandApprovalDecision) => void;
}

interface PendingFileApproval {
  reject: (error: Error) => void;
  requestId: string;
  resolve: (decision: AiFileApprovalDecision) => void;
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
  const [summarizingConversationIds, setSummarizingConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const activeRequestRef = useRef<ActiveAiRequest>();
  const trackedTaskIdRef = useRef<string>();
  const cancelledRequestsRef = useRef(new Set<string>());
  const activeDiagnosticPlansRef = useRef(
    new Map<string, ActiveDiagnosticPlanLocation>(),
  );
  const backendDiagnosticPlanTasksRef = useRef(new Map<string, string>());
  const stoppedDiagnosticPlansRef = useRef(new Set<string>());
  const summaryRequestsRef = useRef(new Set<string>());
  const pendingCommandApprovalsRef = useRef(
    new Map<string, PendingCommandApproval>(),
  );
  const pendingFileApprovalsRef = useRef(
    new Map<string, PendingFileApproval>(),
  );
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

  const decideCommandProposal = useCallback(
    (proposalId: string, decision: AiCommandApprovalDecision) => {
      const pending = pendingCommandApprovalsRef.current.get(proposalId);
      if (!pending) return false;
      pendingCommandApprovalsRef.current.delete(proposalId);
      pending.resolve(decision);
      return true;
    },
    [],
  );

  const decideFileProposal = useCallback(
    (proposalId: string, decision: AiFileApprovalDecision) => {
      const pending = pendingFileApprovalsRef.current.get(proposalId);
      if (!pending) return false;
      pendingFileApprovalsRef.current.delete(proposalId);
      pending.resolve(decision);
      return true;
    },
    [],
  );

  const rejectPendingCommandApprovals = useCallback(
    (requestId: string, message = "AI 请求已取消") => {
      for (const [proposalId, pending] of pendingCommandApprovalsRef.current) {
        if (pending.requestId !== requestId) continue;
        pendingCommandApprovalsRef.current.delete(proposalId);
        pending.reject(new Error(message));
      }
    },
    [],
  );

  const rejectPendingFileApprovals = useCallback(
    (requestId: string, message = "AI 请求已取消") => {
      for (const [proposalId, pending] of pendingFileApprovalsRef.current) {
        if (pending.requestId !== requestId) continue;
        pendingFileApprovalsRef.current.delete(proposalId);
        pending.reject(new Error(message));
      }
    },
    [],
  );

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
          const unsupportedCalls = result.toolCalls.filter(
            (call) =>
              !isAiFileEditToolCall(call) &&
              !isAiFileOperationToolCall(call) &&
              !isAiCommandProposalToolCall(call),
          );
          if (unsupportedCalls.length) {
            throw new Error(
              `AI 后端返回了未处理的工具调用：${unsupportedCalls[0]!.name}`,
            );
          }
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

          const nextProposals: AiFileEditProposal[] = [];
          const nextOperationProposals: AiFileOperationProposal[] = [];
          const nextCommandProposals: AiCommandProposal[] = [];
          const proposalResults = new Map<string, AiToolResult>();
          const commandApprovalDecisions = new Map<
            string,
            Promise<AiCommandApprovalDecision>
          >();
          const fileApprovalDecisions = new Map<
            string,
            Promise<AiFileApprovalDecision>
          >();

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
              fileApprovalDecisions.set(
                call.id,
                new Promise<AiFileApprovalDecision>((resolve, reject) => {
                  pendingFileApprovalsRef.current.set(call.id, {
                    reject,
                    requestId,
                    resolve,
                  });
                }),
              );
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
              fileApprovalDecisions.set(
                call.id,
                new Promise<AiFileApprovalDecision>((resolve, reject) => {
                  pendingFileApprovalsRef.current.set(call.id, {
                    reject,
                    requestId,
                    resolve,
                  });
                }),
              );
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
                throw new Error("当前终端会话不允许提交命令");
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
              commandApprovalDecisions.set(
                call.id,
                new Promise<AiCommandApprovalDecision>((resolve, reject) => {
                  pendingCommandApprovalsRef.current.set(call.id, {
                    reject,
                    requestId,
                    resolve,
                  });
                }),
              );
            } catch (error) {
              proposalError = commandErrorMessage(error);
            }
            if (proposalError) {
              proposalResults.set(
                call.id,
                aiCommandProposalToolResult(call, proposalError),
              );
            }
          }
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
                    }
                  : message,
              ),
          );
          if (commandApprovalDecisions.size || fileApprovalDecisions.size) {
            await persistConversation(proposalConversation);
          }

          const toolResults: AiToolResult[] = [];
          for (const call of result.toolCalls) {
            if (cancelledRequestsRef.current.has(requestId)) {
              throw new Error("AI 请求已取消");
            }
            if (isAiFileEditToolCall(call)) {
              const decision = fileApprovalDecisions.get(call.id);
              if (decision) {
                toolResults.push(
                  aiFileApprovalToolResult(call, await decision),
                );
                continue;
              }
              toolResults.push(
                proposalResults.get(call.id) ??
                  aiFileEditToolResult(call, "文件修改建议未通过本地校验"),
              );
              continue;
            }
            if (isAiFileOperationToolCall(call)) {
              const decision = fileApprovalDecisions.get(call.id);
              if (decision) {
                toolResults.push(
                  aiFileApprovalToolResult(call, await decision),
                );
                continue;
              }
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
              const decision = commandApprovalDecisions.get(call.id);
              if (decision) {
                toolResults.push(
                  aiCommandApprovalToolResult(call, await decision),
                );
                continue;
              }
              toolResults.push(
                proposalResults.get(call.id) ??
                  aiCommandProposalToolResult(
                    call,
                    "终端命令建议未通过本地校验",
                  ),
              );
              continue;
            }
            throw new Error(`AI 请求了不支持的工具：${call.name}`);
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
    sendMessage,
    sending,
    stopDiagnosticPlan,
    summarizingConversationIds,
  };
}
