import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconClose,
  IconDelete,
  IconHistory,
  IconPlus,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
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
  aiConversationExportFilename,
  serializeAiConversationMarkdown,
} from "../ai-conversations";
import { aiFileEditEligibilityError } from "../ai-file-edits";
import type { AiFileApprovalDecision } from "../ai-file-approvals";
import {
  aiContextMentionIds,
  aiRemoteFileContextSource,
  buildAiContextPayloadResult,
  estimateAiRequestTokenBudget,
  stripAiContextMentions,
  isAiRemoteFileContextSourceId,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
} from "../ai-utils";
import { diagnosticInvoke as invoke, recordDiagnostic } from "../diagnostics";
import {
  commandErrorMessage,
  type AgentApprovalMode,
  type AgentActionExecutionResult,
  type AgentCommandObservationRequest,
} from "../tauri-protocol";
import type { TerminalCommandSubmission } from "../terminal-utils";
import {
  aiCommandApprovalDecisionFromSubmission,
  aiCommandResultContextSource,
  type AiCommandApprovalDecision,
  type AiCommandProposal,
} from "../ai-command-proposals";
import {
  useAiCommandActions,
  type AiCommandNotice,
} from "../hooks/useAiCommandActions";
import {
  useAiConversations,
  type AiConversation,
} from "../hooks/useAiConversations";
import {
  useAiConversationActions,
  type AiConversationDeleteConfirmation,
  type AiConversationNotice,
  type AiConversationRenameRequest,
} from "../hooks/useAiConversationActions";
import { useAiDraftActions } from "../hooks/useAiDraftActions";
import {
  useAiFileChangeWorkflow,
  type AiFileChangeConfirmation,
  type AiFileChangeNotice,
} from "../hooks/useAiFileChangeWorkflow";
import { useAiProposalState } from "../hooks/useAiProposalState";
import { useAiRequestOrchestrator } from "../hooks/useAiRequestOrchestrator";
import AiComposer from "./AiComposer";
import AiCommandProposalList from "./AiCommandProposalList";
import AiConversationHistoryDrawer from "./AiConversationHistoryDrawer";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";
import AiFileChangeReviewModals from "./AiFileChangeReviewModals";
import AiFileApprovalCard from "./AiFileApprovalCard";
import AiMessageTimeline from "./AiMessageTimeline";

interface AiAssistantPanelProps {
  canInsertCommand: boolean;
  commandSubmission: TerminalCommandSubmission | null;
  contextSources: AiContextSource[];
  hostId: string | null;
  hostName: string;
  initialContextIds: AiContextSourceId[];
  initialPrompt: string;
  initialPromptRequest: number;
  onClose: () => void;
  onAgentActionExecuted: (
    sessionId: string,
    result: AgentActionExecutionResult,
  ) => void;
  onCommandPrepared: (
    sessionId: string,
    command: string,
  ) => void;
  onRemoveRemoteFile: (sessionId: string, path: string) => void;
  remoteFiles: AiRemoteFileContext[];
  sessionId: string | null;
  settings: AppSettings;
  visible: boolean;
}

const AI_APPROVAL_MODE_OPTIONS = [
  { label: "请求审批", value: "on_request" },
  { label: "替我审批", value: "auto_safe" },
  { label: "完全访问", value: "full_access" },
] satisfies { label: string; value: AgentApprovalMode }[];

function contextSourceDisplayLabel(source: AiContextSource) {
  return isAiRemoteFileContextSourceId(source.id)
    ? `文件:${
        source.label
          .replace(/^文件:/, "")
          .split("/")
          .pop() || "远程文件"
      }`
    : source.label;
}

function confirmAiFileChange(confirmation: AiFileChangeConfirmation) {
  Modal.confirm({
    content: confirmation.content,
    okText: confirmation.okText,
    onOk: confirmation.onConfirm,
    title: confirmation.title,
  });
}

function showAiFileChangeNotice(type: AiFileChangeNotice, content: string) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else Message.error(content);
}

function showAiCommandNotice(type: AiCommandNotice, content: string) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else if (type === "info") Message.info(content);
  else Message.error(content);
}

function showAiDraftNotice(content: string) {
  Message.success(content);
}

function confirmAiConversationDelete(
  confirmation: AiConversationDeleteConfirmation,
) {
  Modal.confirm({
    content: confirmation.content,
    okButtonProps: { status: "danger" },
    okText: "删除",
    onOk: confirmation.onConfirm,
    title: confirmation.title,
  });
}

function requestAiConversationRename(request: AiConversationRenameRequest) {
  let nextTitle = request.initialValue;
  Modal.confirm({
    content: (
      <Input
        autoFocus
        defaultValue={request.initialValue}
        maxLength={80}
        onChange={(value) => {
          nextTitle = value;
        }}
      />
    ),
    okText: "保存",
    onOk: () => request.onConfirm(nextTitle),
    title: request.title,
  });
}

function showAiConversationNotice(type: AiConversationNotice, content: string) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else Message.error(content);
}

async function copyCode(value: string) {
  if (isTauri()) return writeClipboardText(value);
  if (!navigator.clipboard) throw new Error("当前环境无法写入剪贴板");
  return navigator.clipboard.writeText(value);
}

function downloadMarkdownInBrowser(filename: string, contents: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportAiConversationFile(conversation: AiConversation) {
  const contents = serializeAiConversationMarkdown(conversation);
  const filename = aiConversationExportFilename(conversation);
  if (isTauri()) {
    const path = await save({
      defaultPath: filename,
      filters: [{ extensions: ["md"], name: "Markdown" }],
      title: "导出 AI 对话",
    });
    if (!path) return false;
    await invoke("write_config_file", { path, contents });
    return true;
  }
  downloadMarkdownInBrowser(filename, contents);
  return true;
}

function AiAssistantPanel({
  canInsertCommand,
  commandSubmission,
  contextSources,
  hostId,
  hostName,
  initialContextIds,
  initialPrompt,
  initialPromptRequest,
  onClose,
  onAgentActionExecuted,
  onCommandPrepared,
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
  const observeAgentCommandLifecycle = useCallback(
    async (
      messageId: string,
      actionId: string,
      submission: TerminalCommandSubmission,
    ) => {
      const taskId = taskIdForMessage(messageId);
      if (!taskId) throw new Error("AI 命令缺少对应的任务");
      const request: AgentCommandObservationRequest = {
        taskId,
        actionId,
        hostId: submission.hostId,
        sessionId: submission.sessionId,
        submissionId: submission.id,
        phase: submission.phase ?? "submitted",
        command: submission.command,
        exitCode: submission.exitCode,
        durationMs: submission.durationMs,
        reason: submission.reason,
      };
      await invoke("ai_task_command_observe", { request });
    },
    [taskIdForMessage],
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
    commandSubmission,
    conversationsByHost,
    getHostConversations,
    hostId,
    isHostLoaded,
    onActionTransition: transitionAgentAction,
    onActionTransitionError: (error) =>
      Message.error(`AI 动作状态更新失败：${commandErrorMessage(error)}`),
    onCommandLifecycleObserved: observeAgentCommandLifecycle,
    onCommandLifecycleProcessed: (proposalId, submission) => {
      const decision = aiCommandApprovalDecisionFromSubmission(submission);
      if (decision) commandDecisionRef.current(proposalId, decision);
    },
    persistConversation,
    updateMessages,
  });
  const {
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
    [activeTask?.id, activeTask?.plan?.id, activeTask?.status, messages, sending],
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
      const result = await executeAgentAction(
        messageId,
        proposal.id,
        false,
        undefined,
        userConfirmed,
      );
      if (result.actionType !== "terminal_command") {
        throw new Error("AI 命令准备返回了无效结果");
      }
      onCommandPrepared(sessionId, proposal.command);
    },
    onNotice: showAiCommandNotice,
    sessionId,
    setDraft: setConversationDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  });
  const approveCommandAndResume = async (
    messageId: string,
    proposal: AiCommandProposal,
  ) => {
    await approveCommandProposal(messageId, proposal);
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
        const approved = await approveCommandProposal(
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

  const sendConversationMessage = (
    value: string,
    history: AiConversation["messages"] = messages,
    conversationSummary = activeConversation?.summary,
    verificationTarget: ReturnType<typeof captureVerificationTarget> = null,
    includeComposerContext = true,
  ) => {
    if (!hostId || !sessionId || !activeConversation) return;
    return sendMessage({
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
    }).then((completed) => {
      completeVerification(Boolean(completed), verificationTarget);
    });
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
    await rejectCommandAndResume(
      messageId,
      proposal.id,
      {
        feedback: feedback.trim(),
        kind: "revision_requested",
      },
    );
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

  const closePanel = () => {
    if (sending) void cancelRequest();
    closeHistory();
    onClose();
  };

  return (
    <aside className="panel ai-assistant-sidebar-panel">
      <div className="panel-toolbar ai-assistant-title">
        <span className="ai-assistant-heading">
          <span>AI 助手</span>
          <Typography.Text ellipsis title={activeConversation?.title}>
            {activeConversation?.title ?? ""}
          </Typography.Text>
          <Select
            aria-label="AI 审批模式"
            className={`ai-approval-mode ai-approval-mode-${approvalMode}`}
            disabled={!canInsertCommand || sending}
            onChange={(value) => {
              const next = value as AgentApprovalMode;
              if (next !== "full_access" || approvalMode === "full_access") {
                setApprovalMode(next);
                return;
              }
              Modal.confirm({
                cancelText: "取消",
                content:
                  "完全访问会自动执行 AI 提出的终端命令和文件操作，仅在当前主机和当前连接周期内生效。",
                okButtonProps: { status: "danger" },
                okText: "启用",
                onOk: () => setApprovalMode(next),
                title: "启用完全访问？",
              });
            }}
            options={AI_APPROVAL_MODE_OPTIONS}
            size="mini"
            value={approvalMode}
          />
          {activeConversation &&
            (summarizingConversationIds.has(activeConversation.id) ? (
              <Tooltip content="正在后台压缩较早的对话，不影响当前操作">
                <Tag color="arcoblue" size="small">
                  整理中
                </Tag>
              </Tooltip>
            ) : activeConversation.summary ? (
              <Tooltip content="较早对话已压缩为摘要，最近消息仍保留原文">
                <Tag size="small">已摘要</Tag>
              </Tooltip>
            ) : null)}
          {activeTask?.status === "paused_disconnected" && (
            <Tooltip content={activeTask.error ?? "SSH 连接已断开，等待重连"}>
              <Tag color="orange" size="small">
                等待重连
              </Tag>
            </Tooltip>
          )}
        </span>
        <Space size="mini">
          <Tooltip content="新建对话">
            <Button
              aria-label="新建对话"
              disabled={!sessionId || sending}
              icon={<IconPlus />}
              onClick={newConversation}
              type="text"
            />
          </Tooltip>
          <Tooltip content="对话历史">
            <Button
              aria-label="对话历史"
              disabled={!sessionId || sending}
              icon={<IconHistory />}
              onClick={openHistory}
              type="text"
            />
          </Tooltip>
          <Tooltip content="删除当前对话">
            <Button
              aria-label="删除当前对话"
              disabled={!activeConversation || sending}
              icon={<IconDelete />}
              onClick={() =>
                activeConversation && removeConversation(activeConversation.id)
              }
              type="text"
            />
          </Tooltip>
          <Button
            aria-label="关闭 AI 助手"
            icon={<IconClose />}
            onClick={closePanel}
            type="text"
          />
        </Space>
      </div>
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
        {activeApproval && (
          <section
            aria-label="AI 操作审批"
            className="ai-approval-dock"
          >
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
          contextSources={availableContextSources}
          editableRemoteFileCount={editableRemoteFiles.length}
          fileEditEligibility={fileEditEligibility ?? undefined}
          model={settings.aiModel}
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
