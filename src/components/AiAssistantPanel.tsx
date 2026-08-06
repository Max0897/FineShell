import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import type { AppSettings } from "../app-settings";
import {
  aiApprovalRequiresUserDecision,
  buildAiApprovalQueue,
} from "../ai-approval-queue";
import type {
  AiActionExecutionHandler,
  AiActionTransitionHandler,
} from "../ai-action-lifecycle";
import { buildAiConversationRequestMessages } from "../ai-summaries";
import type { AiToolRun } from "../ai-tools";
import {
  agentTaskNeedsRecovery,
  buildAgentRecoveryPrompt,
} from "../ai-task-recovery";
import { aiFileEditEligibilityError } from "../ai-file-edits";
import type { AiFileApprovalDecision } from "../ai-file-approvals";
import {
  aiContextMentionIds,
  aiRemoteFileContextSource,
  buildAiContextPayloadResult,
  estimateAiRequestTokenBudget,
  stripAiContextMentions,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
} from "../ai-utils";
import { diagnosticInvoke as invoke, recordDiagnostic } from "../diagnostics";
import {
  commandErrorMessage,
  listenProtocolEvent,
  type AgentApprovalMode,
  type AgentActionExecutionResult,
  type AgentTask,
  type AgentTaskRecoveryDecision,
} from "../tauri-protocol";
import type { TerminalCommandSubmission } from "../terminal-utils";
import {
  aiCommandApprovalDecisionFromSubmission,
  aiCommandResultContextSource,
  reconcileAiCommandProposalExecution,
  type AiCommandApprovalDecision,
  type AiCommandProposal,
} from "../ai-command-proposals";
import { useAiCommandActions } from "../hooks/useAiCommandActions";
import {
  useAiConversations,
  type AiConversation,
} from "../hooks/useAiConversations";
import { useAiConversationActions } from "../hooks/useAiConversationActions";
import { useAiDraftActions } from "../hooks/useAiDraftActions";
import { useAiFileChangeWorkflow } from "../hooks/useAiFileChangeWorkflow";
import { useAiProposalState } from "../hooks/useAiProposalState";
import { useAiRequestOrchestrator } from "../hooks/useAiRequestOrchestrator";
import AiComposer from "./AiComposer";
import AiCommandProposalList from "./AiCommandProposalList";
import AiConversationHistoryDrawer from "./AiConversationHistoryDrawer";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";
import AiFileChangeReviewModals from "./AiFileChangeReviewModals";
import AiFileApprovalCard from "./AiFileApprovalCard";
import AiMessageTimeline from "./AiMessageTimeline";
import AiTaskRecoveryCard from "./AiTaskRecoveryCard";
import AiAssistantHeader from "./ai/AiAssistantHeader";
import {
  confirmAiConversationDelete,
  confirmAiFileChange,
  contextSourceDisplayLabel,
  copyCode,
  exportAiConversationFile,
  requestAiConversationRename,
  showAiCommandNotice,
  showAiConversationNotice,
  showAiDraftNotice,
  showAiFileChangeNotice,
} from "./ai/aiPanelActions";

interface AiAssistantPanelProps {
  canInsertCommand: boolean;
  contextSources: AiContextSource[];
  hostId: string | null;
  hostName: string;
  initialContextIds: AiContextSourceId[];
  initialPrompt: string;
  initialPromptRequest: number;
  onAgentActionExecuted: (
    sessionId: string,
    result: AgentActionExecutionResult,
  ) => void;
  onRemoveRemoteFile: (sessionId: string, path: string) => void;
  remoteFiles: AiRemoteFileContext[];
  sessionId: string | null;
  settings: AppSettings;
  visible: boolean;
}

function AiAssistantPanel({
  canInsertCommand,
  contextSources,
  hostId,
  hostName,
  initialContextIds,
  initialPrompt,
  initialPromptRequest,
  onAgentActionExecuted,
  onRemoveRemoteFile,
  remoteFiles,
  sessionId,
  settings,
  visible,
}: AiAssistantPanelProps) {
  const [expandedToolRuns, setExpandedToolRuns] = useState<Set<string>>(
    () => new Set(),
  );
  const [approvalMode, setApprovalMode] =
    useState<AgentApprovalMode>("on_request");
  const [automaticApprovalFailures, setAutomaticApprovalFailures] = useState<
    Set<string>
  >(() => new Set());
  const [recoveryDecision, setRecoveryDecision] =
    useState<AgentTaskRecoveryDecision>();
  const automaticApprovalAttemptsRef = useRef(new Set<string>());
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setApprovalMode("on_request");
    setAutomaticApprovalFailures(new Set());
    automaticApprovalAttemptsRef.current.clear();
  }, [canInsertCommand, hostId, sessionId]);

  const {
    activeConversation,
    activeConversationId,
    conversationId: conversationStateKey,
    conversationsByHost,
    createAndActivateConversation,
    draft: prompt,
    getHostConversations,
    hostConversations,
    isHostLoaded,
    loading: historyLoading,
    messages,
    persistConversation,
    removeConversation: removeStoredConversation,
    renameConversation: renameStoredConversation,
    selectConversation: selectStoredConversation,
    setDraft: setConversationDraft,
    updateConversation,
    updateMessages,
  } = useAiConversations({
    hostId,
    hostName,
    onLoadError: (error) =>
      Message.warning(`AI 历史记录加载失败：${commandErrorMessage(error)}`),
    onSaveError: (error) =>
      Message.warning(`AI 对话保存失败：${commandErrorMessage(error)}`),
    sessionId,
  });
  const conversationsByHostRef = useRef(conversationsByHost);
  conversationsByHostRef.current = conversationsByHost;
  const commandResultContextSources = useMemo(
    () =>
      messages.flatMap((message) =>
        (message.commandProposals ?? [])
          .map(aiCommandResultContextSource)
          .filter((source) => source !== null),
      ),
    [messages],
  );
  const commandDecisionRef = useRef<
    (proposalId: string, decision: AiCommandApprovalDecision) => boolean
  >(() => false);
  const taskIdForMessage = useCallback(
    (messageId: string) =>
      Object.values(conversationsByHost)
        .flat()
        .flatMap((conversation) => conversation.messages)
        .find((message) => message.id === messageId)?.taskId,
    [conversationsByHost],
  );
  const transitionAgentAction = useCallback<AiActionTransitionHandler>(
    async (messageId, actionId, transition, detail) => {
      const taskId = taskIdForMessage(messageId);
      if (!taskId) throw new Error("AI 动作缺少对应的任务");
      await invoke("ai_task_action_transition", {
        request: {
          taskId,
          actionId,
          transition,
          ...detail,
        },
      });
    },
    [taskIdForMessage],
  );
  const executeAgentAction = useCallback<AiActionExecutionHandler>(
    async (
      messageId,
      actionId,
      rollback = false,
      contentOverride,
      userConfirmed = true,
    ) => {
      const taskId = taskIdForMessage(messageId);
      if (!taskId) throw new Error("AI 动作缺少对应的任务");
      if (!sessionId) throw new Error("当前终端会话不可用");
      const result = await invoke<AgentActionExecutionResult>(
        "ai_task_action_execute",
        {
          request: {
            taskId,
            actionId,
            rollback,
            userConfirmed,
            contentOverride,
          },
        },
      );
      onAgentActionExecuted(sessionId, result);
      return result;
    },
    [onAgentActionExecuted, sessionId, taskIdForMessage],
  );
  const availableContextSources = useMemo(() => {
    const sources = new Map(
      contextSources.map((source) => [source.id, source]),
    );
    for (const source of commandResultContextSources) {
      sources.set(source.id, source);
    }
    return Array.from(sources.values());
  }, [commandResultContextSources, contextSources]);
  const {
    rejectCommandProposal,
    rejectFileEditProposal,
    rejectFileOperationProposal,
    retryFileEditProposal,
    retryFileOperationProposal,
    updateCommandProposal,
    updateCommandProposalInConversation,
    updateFileEditProposal,
    updateFileOperationProposal,
  } = useAiProposalState({
    activeConversationId: activeConversation?.id,
    commandSubmission: null,
    conversationsByHost,
    getHostConversations,
    hostId,
    isHostLoaded,
    onActionTransition: transitionAgentAction,
    onActionTransitionError: (error) =>
      Message.error(`AI 动作状态更新失败：${commandErrorMessage(error)}`),
    onCommandLifecycleObserved: async () => undefined,
    onCommandLifecycleProcessed: (proposalId, submission) => {
      const decision = aiCommandApprovalDecisionFromSubmission(submission);
      if (decision) commandDecisionRef.current(proposalId, decision);
    },
    persistConversation,
    updateMessages,
  });

  const reconcileTaskCommandExecutions = useCallback(
    (task: AgentTask) => {
      const actions = new Map(
        task.actions
          .filter((action) => action.commandExecution)
          .map((action) => [action.id, action]),
      );
      if (actions.size === 0) return;
      for (const [targetHostId, conversations] of Object.entries(
        conversationsByHostRef.current,
      )) {
        const conversation = conversations.find((candidate) =>
          candidate.messages.some((message) => message.taskId === task.id),
        );
        if (!conversation) continue;
        updateMessages(targetHostId, conversation.id, (current) =>
          current.map((message) =>
            message.taskId === task.id
              ? {
                  ...message,
                  commandProposals: message.commandProposals?.map(
                    (proposal) => {
                      const action = actions.get(proposal.id);
                      return action?.commandExecution
                        ? reconcileAiCommandProposalExecution(
                            proposal,
                            action.commandExecution,
                            {
                              evidence: action.verificationEvidence,
                              status: action.verificationStatus,
                            },
                          )
                        : proposal;
                    },
                  ),
                }
              : message,
          ),
        );
        break;
      }
    },
    [updateMessages],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("ai-task", ({ payload }) => {
      if (disposed) return;
      reconcileTaskCommandExecutions(payload.task);
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        recordDiagnostic(
          "warn",
          "ai.command-runtime",
          "监听 AI 后台命令状态失败",
          { error: commandErrorMessage(error) },
        );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reconcileTaskCommandExecutions]);
  const {
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
  } = useAiRequestOrchestrator({
    approvalMode,
    onCancelError: (error) => Message.error(commandErrorMessage(error)),
    onMissingModel: () => Message.warning("请先在设置中配置 AI 模型"),
    onSummaryError: (error) =>
      recordDiagnostic("warn", "ai.summary", "后台整理对话摘要失败", {
        error: commandErrorMessage(error),
      }),
    persistConversation,
    restoreTaskId: [...messages].reverse().find((message) => message.taskId)
      ?.taskId,
    sessionId,
    settings,
    setDraft: setConversationDraft,
    updateConversation,
    updateMessages,
  });
  useEffect(() => {
    if (activeTask) reconcileTaskCommandExecutions(activeTask);
  }, [activeTask, reconcileTaskCommandExecutions]);
  const approvalQueue = useMemo(
    () =>
      buildAiApprovalQueue(
        messages,
        activeTask?.id,
        sending,
        activeTask?.status === "awaiting_approval"
          ? activeTask.plan?.id
          : undefined,
      ),
    [
      activeTask?.id,
      activeTask?.plan?.id,
      activeTask?.status,
      messages,
      sending,
    ],
  );
  const queuedApproval = approvalQueue[0];
  const queuedApprovalId = queuedApproval
    ? queuedApproval.kind === "diagnostic"
      ? queuedApproval.plan.id
      : queuedApproval.proposal.id
    : undefined;
  const automaticApproval =
    queuedApproval &&
    queuedApprovalId &&
    !automaticApprovalFailures.has(queuedApprovalId) &&
    !aiApprovalRequiresUserDecision(queuedApproval, approvalMode)
      ? queuedApproval
      : undefined;
  const activeApproval = automaticApproval ? undefined : queuedApproval;
  const dockedCommandProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "command")
          .map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  const dockedDiagnosticPlanIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "diagnostic")
          .map(({ plan }) => plan.id),
      ),
    [approvalQueue],
  );
  const dockedFileEditProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "file-edit")
          .map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  const dockedFileOperationProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "file-operation")
          .map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  commandDecisionRef.current = decideCommandProposal;
  const {
    approveCommandProposal,
    captureVerificationTarget,
    completeVerification,
    copyAllCommandProposals,
    copyCommandProposal,
    prepareCommandVerification,
    updateDraft,
  } = useAiCommandActions({
    contextSources: availableContextSources,
    conversationId: conversationStateKey,
    hostId,
    onCopyText: copyCode,
    onPrepareCommand: async (messageId, proposal, userConfirmed) => {
      if (!sessionId) throw new Error("当前终端会话不可用");
      if (!hostId) throw new Error("当前主机不可用");
      const result = await executeAgentAction(
        messageId,
        proposal.id,
        false,
        undefined,
        userConfirmed,
      );
      if (result.actionType !== "terminal_command") {
        throw new Error("AI 后台命令返回了无效结果");
      }
      if (!result.command) throw new Error("AI 后台命令缺少执行结果");
      return {
        command: proposal.command,
        completedAt: new Date(result.command.completedAt).toISOString(),
        durationMs: result.command.durationMs,
        exitCode: result.command.exitCode ?? undefined,
        hostId,
        id: result.command.submissionId,
        output: result.command.output ?? undefined,
        outputTruncated: result.command.outputTruncated,
        stdout: result.command.stdout ?? undefined,
        stdoutTruncated: result.command.stdoutTruncated,
        stderr: result.command.stderr ?? undefined,
        stderrTruncated: result.command.stderrTruncated,
        phase: result.command.phase,
        reason: result.command.reason ?? undefined,
        sessionId,
        submittedAt: new Date(result.command.submittedAt).toISOString(),
      } satisfies TerminalCommandSubmission;
    },
    onNotice: showAiCommandNotice,
    sessionId,
    setDraft: setConversationDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  });
  const executeCommandAndResume = async (
    messageId: string,
    proposal: AiCommandProposal,
    userConfirmed = true,
  ) => {
    const submission = await approveCommandProposal(
      messageId,
      proposal,
      userConfirmed,
    );
    if (!submission) return false;
    const decision = aiCommandApprovalDecisionFromSubmission(submission);
    if (decision) commandDecisionRef.current(proposal.id, decision);
    return true;
  };
  const approveCommandAndResume = async (
    messageId: string,
    proposal: AiCommandProposal,
  ) => {
    await executeCommandAndResume(messageId, proposal);
  };
  const rejectCommandAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiCommandApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectCommandProposal(messageId, proposalId);
    if (updated) decideCommandProposal(proposalId, decision);
    return updated;
  };
  const {
    applying: fileEditApplying,
    approveFileEditProposal,
    approveFileOperationProposal,
    applyReviewedFileEdit,
    applyReviewedFileOperation,
    closeFileChangeReview,
    confirmApplyAllFileEdits,
    confirmApplyAllFileOperations,
    confirmRollbackAllFileEdits,
    confirmRollbackAllFileOperations,
    confirmRollbackFileEdit: confirmRollbackAppliedFileEdit,
    confirmRollbackFileOperation,
    fileChangeReview,
    fileChangeReviewItems,
    openFileEditReview,
    openFileOperationReview,
    reviewedFileEditError,
    reviewedFileEditContent,
    reviewedFileEditProposal,
    reviewedFileOperationProposal,
    selectFileChangeReview,
    setFileEditReviewContent,
  } = useAiFileChangeWorkflow({
    messages,
    onExecuteAction: executeAgentAction,
    onConfirm: confirmAiFileChange,
    onNotice: showAiFileChangeNotice,
    sessionId,
    updateFileEditProposal,
    updateFileOperationProposal,
  });
  const completeFileApproval = (
    proposalId: string,
    decision: AiFileApprovalDecision,
  ) => decideFileProposal(proposalId, decision);
  const approveFileEditAndResume = async (
    messageId: string,
    proposal: NonNullable<
      Extract<typeof activeApproval, { kind: "file-edit" }>
    >["proposal"],
    userConfirmed = true,
  ) => {
    const result = await approveFileEditProposal(
      messageId,
      proposal,
      userConfirmed,
    );
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件已更新" }
        : {
            kind: "execution_failed",
            reason:
              result === "conflict"
                ? "远程文件已被其他程序修改"
                : "远程文件写入失败",
          },
    );
    return result;
  };
  const approveFileOperationAndResume = async (
    messageId: string,
    proposal: NonNullable<
      Extract<typeof activeApproval, { kind: "file-operation" }>
    >["proposal"],
    userConfirmed = true,
  ) => {
    const result = await approveFileOperationProposal(
      messageId,
      proposal,
      userConfirmed,
    );
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件操作已完成" }
        : {
            kind: "execution_failed",
            reason:
              result === "conflict"
                ? "远端文件状态已发生变化"
                : "远程文件操作失败",
          },
    );
    return result;
  };
  const rejectFileEditAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiFileApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectFileEditProposal(messageId, proposalId);
    if (updated) completeFileApproval(proposalId, decision);
  };
  const rejectFileOperationAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiFileApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectFileOperationProposal(messageId, proposalId);
    if (updated) completeFileApproval(proposalId, decision);
  };
  const applyReviewedFileEditAndResume = async () => {
    const proposal = reviewedFileEditProposal;
    const result = await applyReviewedFileEdit();
    if (!proposal || !result) return;
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件已更新" }
        : {
            kind: "execution_failed",
            reason:
              result === "conflict"
                ? "远程文件已被其他程序修改"
                : "远程文件写入失败",
          },
    );
  };
  const applyReviewedFileOperationAndResume = async () => {
    const proposal = reviewedFileOperationProposal;
    const result = await applyReviewedFileOperation();
    if (!proposal || !result) return;
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件操作已完成" }
        : {
            kind: "execution_failed",
            reason:
              result === "conflict"
                ? "远端文件状态已发生变化"
                : "远程文件操作失败",
          },
    );
  };

  useEffect(() => {
    if (!automaticApproval || !queuedApprovalId || !sending) return;
    if (automaticApprovalAttemptsRef.current.has(queuedApprovalId)) return;
    automaticApprovalAttemptsRef.current.add(queuedApprovalId);

    void (async () => {
      if (automaticApproval.kind === "command") {
        const approved = await executeCommandAndResume(
          automaticApproval.messageId,
          automaticApproval.proposal,
          false,
        );
        if (!approved) {
          setAutomaticApprovalFailures((current) =>
            new Set(current).add(queuedApprovalId),
          );
        }
        return;
      }
      if (automaticApproval.kind === "file-edit") {
        await approveFileEditAndResume(
          automaticApproval.messageId,
          automaticApproval.proposal,
          false,
        );
        return;
      }
      if (automaticApproval.kind === "file-operation") {
        await approveFileOperationAndResume(
          automaticApproval.messageId,
          automaticApproval.proposal,
          false,
        );
      }
    })();
  }, [automaticApproval, queuedApprovalId, sending]);

  const {
    addToolRunToDraft,
    applyPromptPreset,
    removeRemoteFile,
    updateRemoteFileMention,
  } = useAiDraftActions({
    contextSources: availableContextSources,
    conversationId: conversationStateKey,
    initialContextIds,
    initialPrompt,
    initialPromptRequest,
    onNotice: showAiDraftNotice,
    onRemoveRemoteFile,
    prompt,
    sending,
    sessionId,
    updateDraft,
    visible,
  });
  const {
    closeHistory,
    exportConversation,
    historyConversations,
    historyVisible,
    newConversation,
    openHistory,
    removeConversation,
    renameConversation,
    selectConversation,
  } = useAiConversationActions({
    conversations: hostConversations,
    createConversation: createAndActivateConversation,
    exportConversation: exportAiConversationFile,
    hostId,
    onConfirmDelete: confirmAiConversationDelete,
    onNotice: showAiConversationNotice,
    onRequestRename: requestAiConversationRename,
    removeConversation: removeStoredConversation,
    renameConversation: renameStoredConversation,
    selectConversation: selectStoredConversation,
    sending,
    sessionId,
  });
  const selectedContextIds = aiContextMentionIds(
    prompt,
    availableContextSources,
  );
  const question = stripAiContextMentions(prompt, availableContextSources);

  const selectedContextSources = availableContextSources.filter(
    (source) =>
      selectedContextIds.includes(source.id) && Boolean(source.content.trim()),
  );
  const contextPayload = buildAiContextPayloadResult(
    availableContextSources,
    selectedContextIds,
    settings.aiContextMaxChars,
  );
  const context = contextPayload.content;
  const tokenBudget = estimateAiRequestTokenBudget(
    buildAiConversationRequestMessages(messages, activeConversation?.summary),
    question,
    contextPayload,
    settings.aiContextMaxChars,
  );
  const selectedRemoteFiles = remoteFiles.filter((file) =>
    selectedContextIds.includes(aiRemoteFileContextSource(file).id),
  );
  const editableRemoteFiles =
    settings.aiFileProposalsEnabled && canInsertCommand
      ? selectedRemoteFiles.filter(
          (file) =>
            !aiFileEditEligibilityError(
              file,
              context,
              settings.aiContextMaxChars,
            ),
        )
      : [];
  const currentRemoteDirectory =
    contextSources
      .find((source) => source.id === "sftp-path")
      ?.content.trim() || null;
  const hasRecentTerminalOutput = Boolean(
    contextSources
      .find((source) => source.id === "terminal-output")
      ?.content.trim(),
  );
  const operationDirectory =
    settings.aiFileProposalsEnabled &&
    canInsertCommand &&
    selectedContextIds.includes("sftp-path")
      ? currentRemoteDirectory
      : null;
  const fileEditEligibility = !settings.aiFileProposalsEnabled
    ? "文件变更提案权限已在设置中关闭"
    : !selectedRemoteFiles.length
      ? "请在输入框中提及远程文件后再生成修改建议"
      : !canInsertCommand
        ? "当前终端会话未连接，不能应用文件修改"
        : editableRemoteFiles.length === selectedRemoteFiles.length
          ? null
          : editableRemoteFiles.length
            ? `${editableRemoteFiles.length}/${selectedRemoteFiles.length} 个文件可生成修改建议，其余文件只能分析`
            : aiFileEditEligibilityError(
                selectedRemoteFiles[0] ?? null,
                context,
                settings.aiContextMaxChars,
              );

  const toggleToolRun = (key: string) => {
    setExpandedToolRuns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyToolRun = async (run: AiToolRun) => {
    const value = run.summary ?? run.error;
    if (!value) return;
    try {
      await copyCode(value);
      Message.success("诊断摘要已复制");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  };

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const contentElement = contentRef.current;
      if (contentElement)
        contentElement.scrollTop = contentElement.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, visible]);

  useEffect(() => {
    if (visible) return;
    closeHistory();
    closeFileChangeReview();
  }, [fileEditApplying, visible]);

  const sendConversationMessage = (
    value: string,
    history: AiConversation["messages"] = messages,
    conversationSummary = activeConversation?.summary,
    verificationTarget: ReturnType<typeof captureVerificationTarget> = null,
    includeComposerContext = true,
    requestValue?: string,
    approvalModeOverride?: AgentApprovalMode,
  ) => {
    if (!hostId || !sessionId || !activeConversation) return;
    return sendMessage({
      approvalModeOverride,
      commandProposalEnabled:
        canInsertCommand && settings.aiCommandProposalsEnabled,
      conversationSummary,
      context: includeComposerContext ? context : "",
      contextLabels: includeComposerContext
        ? selectedContextSources.map(contextSourceDisplayLabel)
        : [],
      currentOperationDirectory: includeComposerContext
        ? operationDirectory
        : null,
      editableFiles: includeComposerContext ? editableRemoteFiles : [],
      history,
      targetConversationId: activeConversation.id,
      targetDirectory: currentRemoteDirectory,
      targetHostId: hostId,
      targetSessionId: sessionId,
      toolCurrentDirectory: currentRemoteDirectory,
      value,
      requestValue,
    }).then((completed) => {
      completeVerification(Boolean(completed), verificationTarget);
    });
  };

  const decideInterruptedTask = async (decision: AgentTaskRecoveryDecision) => {
    if (!activeTask || recoveryDecision) return;
    setRecoveryDecision(decision);
    try {
      const recovery = await resolveTaskInterruption(activeTask.id, decision);
      if (decision === "finish") return;
      if (!hostId || recovery.hostId !== hostId) {
        throw new Error("中断任务与当前主机不匹配，无法继续");
      }
      setApprovalMode("on_request");
      await sendConversationMessage(
        decision === "retry" ? "重新尝试" : "继续分析",
        messages,
        activeConversation?.summary,
        null,
        false,
        buildAgentRecoveryPrompt(recovery, decision),
        "on_request",
      );
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setRecoveryDecision(undefined);
    }
  };

  const send = () => {
    const verificationTarget = captureVerificationTarget(prompt);
    void sendConversationMessage(
      question,
      messages,
      activeConversation?.summary,
      verificationTarget,
    );
  };

  const reviseCommandProposal = async (
    messageId: string,
    proposal: AiCommandProposal,
    feedback: string,
  ) => {
    if (!feedback.trim()) return;
    await rejectCommandAndResume(messageId, proposal.id, {
      feedback: feedback.trim(),
      kind: "revision_requested",
    });
  };

  const retry = (assistantIndex: number) => {
    if (!hostId || !sessionId || !activeConversation || sending) return;
    const userMessage = messages[assistantIndex - 1];
    const assistantMessage = messages[assistantIndex];
    if (
      !userMessage ||
      userMessage.role !== "user" ||
      !assistantMessage?.failed
    ) {
      return;
    }
    void sendMessage({
      commandProposalEnabled:
        canInsertCommand && settings.aiCommandProposalsEnabled,
      conversationSummary:
        activeConversation.summary &&
        (messages
          .slice(0, assistantIndex - 1)
          .some(
            (message) =>
              message.id === activeConversation.summary?.throughMessageId,
          ) ||
          !messages.some(
            (message) =>
              message.id === activeConversation.summary?.throughMessageId,
          ))
          ? activeConversation.summary
          : undefined,
      context: userMessage.context ?? "",
      contextLabels: userMessage.contextLabels ?? [],
      currentOperationDirectory: null,
      editableFiles: [],
      history: messages.slice(0, assistantIndex - 1),
      targetConversationId: activeConversation.id,
      targetDirectory: currentRemoteDirectory,
      targetHostId: hostId,
      targetSessionId: sessionId,
      toolCurrentDirectory: currentRemoteDirectory,
      value: userMessage.content,
    });
  };

  return (
    <aside className="panel ai-assistant-sidebar-panel">
      <AiAssistantHeader
        conversationSummarized={Boolean(activeConversation?.summary)}
        conversationSummarizing={Boolean(
          activeConversation &&
          summarizingConversationIds.has(activeConversation.id),
        )}
        conversationTitle={activeConversation?.title ?? ""}
        disconnectedError={
          activeTask?.status === "paused_disconnected"
            ? (activeTask.error ?? "")
            : undefined
        }
        onNew={newConversation}
        onOpenHistory={openHistory}
        sending={sending}
        sessionAvailable={Boolean(sessionId)}
      />

      <div className="ai-assistant-layout">
        <AiMessageTimeline
          activeConversationAvailable={Boolean(activeConversation)}
          applyingFileChanges={fileEditApplying}
          canInsertCommand={canInsertCommand}
          dockedCommandProposalIds={dockedCommandProposalIds}
          dockedDiagnosticPlanIds={dockedDiagnosticPlanIds}
          dockedFileEditProposalIds={dockedFileEditProposalIds}
          dockedFileOperationProposalIds={dockedFileOperationProposalIds}
          expandedToolRuns={expandedToolRuns}
          hasRecentTerminalOutput={hasRecentTerminalOutput}
          hostName={hostName}
          loading={historyLoading}
          messages={messages}
          onAddToolRunToDraft={addToolRunToDraft}
          onAnalyzeCommand={prepareCommandVerification}
          onApplyAllFileEdits={confirmApplyAllFileEdits}
          onApplyAllFileOperations={confirmApplyAllFileOperations}
          onCopyCode={copyCode}
          onCopyCommand={copyCommandProposal}
          onCopyCommands={copyAllCommandProposals}
          onCopyToolRun={copyToolRun}
          onCancelDiagnosticPlan={cancelDiagnosticPlan}
          onConfirmDiagnosticPlan={confirmDiagnosticPlan}
          onReviseDiagnosticPlan={reviseDiagnosticPlan}
          onApproveCommandProposal={approveCommandAndResume}
          onOpenFileEditReview={openFileEditReview}
          onOpenFileOperationReview={openFileOperationReview}
          onRejectCommand={rejectCommandAndResume}
          onReviseCommand={reviseCommandProposal}
          onRejectFileEdit={rejectFileEditProposal}
          onRejectFileOperation={rejectFileOperationProposal}
          onRetryFileEdit={retryFileEditProposal}
          onRetryFileOperation={retryFileOperationProposal}
          onRetryMessage={retry}
          onRollbackAllFileEdits={confirmRollbackAllFileEdits}
          onRollbackAllFileOperations={confirmRollbackAllFileOperations}
          onRollbackFileEdit={confirmRollbackAppliedFileEdit}
          onRollbackFileOperation={confirmRollbackFileOperation}
          onSelectPreset={applyPromptPreset}
          onStopDiagnosticPlan={stopDiagnosticPlan}
          onToggleToolRun={toggleToolRun}
          scrollRef={contentRef}
          sending={sending}
          sessionId={sessionId}
        />
        {agentTaskNeedsRecovery(activeTask) && (
          <AiTaskRecoveryCard
            busyDecision={recoveryDecision}
            disconnected={activeTask.status === "paused_disconnected"}
            onDecision={(decision) => void decideInterruptedTask(decision)}
            reason={activeTask.error ?? "AI 任务执行被中断"}
            sessionAvailable={Boolean(sessionId)}
          />
        )}
        {activeApproval && (
          <section aria-label="AI 操作审批" className="ai-approval-dock">
            {activeApproval.kind === "command" ? (
              <AiCommandProposalList
                canInsertCommand={canInsertCommand}
                hasRecentTerminalOutput={hasRecentTerminalOutput}
                hostName={hostName}
                key={activeApproval.proposal.id}
                onAnalyze={(proposal) =>
                  prepareCommandVerification(activeApproval.messageId, proposal)
                }
                onApprove={(proposal) =>
                  approveCommandAndResume(activeApproval.messageId, proposal)
                }
                onCopy={copyCommandProposal}
                onCopyAll={copyAllCommandProposals}
                onReject={(proposalId) =>
                  rejectCommandAndResume(activeApproval.messageId, proposalId)
                }
                onRevise={(proposal, feedback) =>
                  reviseCommandProposal(
                    activeApproval.messageId,
                    proposal,
                    feedback,
                  )
                }
                presentation="approval"
                proposals={[activeApproval.proposal]}
                queueCount={approvalQueue.length}
                sending={sending}
                sessionId={sessionId}
              />
            ) : activeApproval.kind === "diagnostic" ? (
              <AiDiagnosticPlanList
                expandedRuns={expandedToolRuns}
                key={activeApproval.plan.id}
                messageId={activeApproval.messageId}
                onAddToDraft={addToolRunToDraft}
                onCancel={cancelDiagnosticPlan}
                onConfirm={confirmDiagnosticPlan}
                onCopy={copyToolRun}
                onRevise={reviseDiagnosticPlan}
                onStop={stopDiagnosticPlan}
                onToggleRun={toggleToolRun}
                plans={[activeApproval.plan]}
                presentation="approval"
                queueCount={approvalQueue.length}
                runs={activeApproval.runs}
                sending={sending}
              />
            ) : activeApproval.kind === "file-edit" ? (
              <AiFileApprovalCard
                applying={fileEditApplying}
                editProposal={activeApproval.proposal}
                key={activeApproval.proposal.id}
                onApprove={async () => {
                  await approveFileEditAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal,
                  );
                }}
                onOpenReview={() =>
                  openFileEditReview(
                    activeApproval.messageId,
                    activeApproval.proposal,
                  )
                }
                onReject={() =>
                  rejectFileEditAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal.id,
                  )
                }
                onRevise={(feedback) =>
                  rejectFileEditAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal.id,
                    { feedback, kind: "revision_requested" },
                  )
                }
                queueCount={approvalQueue.length}
              />
            ) : (
              <AiFileApprovalCard
                applying={fileEditApplying}
                key={activeApproval.proposal.id}
                onApprove={async () => {
                  await approveFileOperationAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal,
                  );
                }}
                onOpenReview={() =>
                  openFileOperationReview(
                    activeApproval.messageId,
                    activeApproval.proposal,
                  )
                }
                onReject={() =>
                  rejectFileOperationAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal.id,
                  )
                }
                onRevise={(feedback) =>
                  rejectFileOperationAndResume(
                    activeApproval.messageId,
                    activeApproval.proposal.id,
                    { feedback, kind: "revision_requested" },
                  )
                }
                operationProposal={activeApproval.proposal}
                queueCount={approvalQueue.length}
              />
            )}
          </section>
        )}
        <AiComposer
          activeConversationAvailable={Boolean(activeConversation)}
          approvalMode={approvalMode}
          canInsertCommand={canInsertCommand}
          contextSources={availableContextSources}
          editableRemoteFileCount={editableRemoteFiles.length}
          fileEditEligibility={fileEditEligibility ?? undefined}
          model={settings.aiModel}
          onApprovalModeChange={setApprovalMode}
          onCancel={cancelRequest}
          onChange={updateDraft}
          onRemoveRemoteFile={removeRemoteFile}
          onSend={send}
          onToggleRemoteFile={updateRemoteFileMention}
          prompt={prompt}
          remoteFiles={remoteFiles}
          selectedContextIds={selectedContextIds}
          sendEnabled={Boolean(question && activeConversation)}
          sending={sending}
          tokenBudget={tokenBudget}
        />
      </div>
      <AiFileChangeReviewModals
        activeKey={fileChangeReview?.activeKey}
        applying={fileEditApplying}
        editContent={reviewedFileEditContent}
        editError={reviewedFileEditError}
        items={fileChangeReviewItems}
        onApplyEdit={applyReviewedFileEditAndResume}
        onApplyOperation={applyReviewedFileOperationAndResume}
        onChangeEditContent={setFileEditReviewContent}
        onClose={closeFileChangeReview}
        onSelect={selectFileChangeReview}
        visible={Boolean(fileChangeReview)}
      />
      <AiConversationHistoryDrawer
        activeConversationId={activeConversationId ?? null}
        conversations={historyConversations}
        loading={historyLoading}
        onClose={closeHistory}
        onDelete={removeConversation}
        onExport={exportConversation}
        onRename={renameConversation}
        onSelect={selectConversation}
        visible={historyVisible}
      />
    </aside>
  );
}

export default AiAssistantPanel;
