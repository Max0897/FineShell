import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
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
  IconSafe,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../app-settings";
import { buildAiConversationRequestMessages } from "../ai-summaries";
import {
  aiToolRequiresConfirmation,
  aiToolTarget,
  type AiToolRun,
} from "../ai-tools";
import {
  aiConversationExportFilename,
  serializeAiConversationMarkdown,
} from "../ai-conversations";
import { aiFileEditEligibilityError } from "../ai-file-edits";
import {
  type AiFileOperationExecutionRequest,
  type AiFileOperationResult,
} from "../ai-file-operations";
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
import {
  diagnosticInvoke as invoke,
  recordDiagnostic,
} from "../diagnostics";
import {
  commandErrorMessage,
  type AiToolCall,
} from "../tauri-protocol";
import type { TerminalCommandSubmission } from "../terminal-utils";
import {
  useAiCommandActions,
  type AiCommandConfirmation,
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
import AiAuditDrawer from "./AiAuditDrawer";
import AiConversationHistoryDrawer from "./AiConversationHistoryDrawer";
import AiFileChangeReviewModals from "./AiFileChangeReviewModals";
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
  onInsertCommand: (command: string) => Promise<void>;
  onApplyRemoteFileEdit: (
    sessionId: string,
    file: AiRemoteFileContext,
    content: string,
  ) => Promise<AiRemoteFileContext>;
  onApplyRemoteFileOperation: (
    sessionId: string,
    request: AiFileOperationExecutionRequest,
  ) => Promise<AiFileOperationResult>;
  onRemoveRemoteFile: (sessionId: string, path: string) => void;
  remoteFiles: AiRemoteFileContext[];
  sessionId: string | null;
  settings: AppSettings;
  visible: boolean;
}

function confirmAiToolExecution(call: AiToolCall) {
  if (!aiToolRequiresConfirmation(call.name)) return Promise.resolve(true);
  const target = aiToolTarget(call);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(allowed);
    };
    Modal.confirm({
      cancelText: "拒绝",
      content: (
        <div className="ai-tool-confirmation">
          <Typography.Paragraph>
            AI 请求从当前服务器执行主动网络探测。该操作只读取结果，不会修改服务器配置。
          </Typography.Paragraph>
          <Typography.Text code>{target}</Typography.Text>
        </div>
      ),
      okText: "允许执行",
      onCancel: () => finish(false),
      onOk: () => finish(true),
      title: call.name === "ping_target" ? "允许执行 Ping？" : "允许执行路由追踪？",
    });
  });
}

function contextSourceDisplayLabel(source: AiContextSource) {
  return isAiRemoteFileContextSourceId(source.id)
    ? `文件:${source.label.replace(/^文件:/, "").split("/").pop() || "远程文件"}`
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

function confirmAiCommand(confirmation: AiCommandConfirmation) {
  Modal.confirm({
    content: confirmation.content,
    okButtonProps: confirmation.danger ? { status: "danger" } : undefined,
    okText: "确认填入",
    onOk: confirmation.onConfirm,
    title: confirmation.title,
  });
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

function showAiConversationNotice(
  type: AiConversationNotice,
  content: string,
) {
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
  onApplyRemoteFileEdit,
  onApplyRemoteFileOperation,
  onInsertCommand,
  onRemoveRemoteFile,
  remoteFiles,
  sessionId,
  settings,
  visible,
}: AiAssistantPanelProps) {
  const [expandedToolRuns, setExpandedToolRuns] = useState<Set<string>>(
    () => new Set(),
  );
  const [auditVisible, setAuditVisible] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

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
      Message.warning(
        `AI 历史记录加载失败：${commandErrorMessage(error)}`,
      ),
    onSaveError: (error) =>
      Message.warning(`AI 对话保存失败：${commandErrorMessage(error)}`),
    sessionId,
  });
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
    persistConversation,
    updateMessages,
  });
  const {
    captureVerificationTarget,
    completeVerification,
    confirmInsertCommandProposal,
    copyAllCommandProposals,
    copyCommandProposal,
    prepareCommandVerification,
    updateDraft,
  } = useAiCommandActions({
    contextSources,
    conversationId: conversationStateKey,
    hostId,
    onConfirm: confirmAiCommand,
    onCopyText: copyCode,
    onInsertCommand,
    onNotice: showAiCommandNotice,
    sessionId,
    setDraft: setConversationDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  });
  const {
    applying: fileEditApplying,
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
    selectFileChangeReview,
    setFileEditReviewContent,
  } = useAiFileChangeWorkflow({
    messages,
    onApplyRemoteFileEdit,
    onApplyRemoteFileOperation,
    onConfirm: confirmAiFileChange,
    onNotice: showAiFileChangeNotice,
    sessionId,
    updateFileEditProposal,
    updateFileOperationProposal,
  });
  const {
    cancelRequest,
    rerunTool: rerunRequestTool,
    sendMessage,
    sending,
    summarizingConversationIds,
  } = useAiRequestOrchestrator({
    confirmToolExecution: confirmAiToolExecution,
    onCancelError: (error) => Message.error(commandErrorMessage(error)),
    onMissingModel: () => Message.warning("请先在设置中配置 AI 模型"),
    onSummaryError: (error) =>
      recordDiagnostic("warn", "ai.summary", "后台整理对话摘要失败", {
        error: commandErrorMessage(error),
      }),
    persistConversation,
    sessionId,
    settings,
    setDraft: setConversationDraft,
    updateConversation,
    updateMessages,
  });
  const {
    addToolRunToDraft,
    applyPromptPreset,
    removeRemoteFile,
    updateRemoteFileMention,
  } = useAiDraftActions({
    contextSources,
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
  const selectedContextIds = aiContextMentionIds(prompt, contextSources);
  const question = stripAiContextMentions(prompt, contextSources);

  const selectedContextSources = contextSources.filter(
    (source) =>
      selectedContextIds.includes(source.id) && Boolean(source.content.trim()),
  );
  const contextPayload = buildAiContextPayloadResult(
    contextSources,
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
    contextSources.find((source) => source.id === "sftp-path")?.content.trim() ||
    null;
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

  const rerunTool = async (messageId: string, run: AiToolRun) => {
    if (!hostId || !sessionId || !activeConversation || sending) return;
    await rerunRequestTool({
      conversationId: activeConversation.id,
      currentDirectory: currentRemoteDirectory,
      hostId,
      messageId,
      run,
      sessionId,
    });
  };

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const contentElement = contentRef.current;
      if (contentElement) contentElement.scrollTop = contentElement.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, visible]);

  const send = () => {
    if (!hostId || !sessionId || !activeConversation) return;
    const verificationTarget = captureVerificationTarget(prompt);
    void sendMessage({
      commandProposalEnabled:
        canInsertCommand && settings.aiCommandProposalsEnabled,
      conversationSummary: activeConversation.summary,
      context,
      contextLabels: selectedContextSources.map(contextSourceDisplayLabel),
      currentOperationDirectory: operationDirectory,
      editableFiles: editableRemoteFiles,
      history: messages,
      targetConversationId: activeConversation.id,
      targetDirectory: currentRemoteDirectory,
      targetHostId: hostId,
      targetSessionId: sessionId,
      toolCurrentDirectory: currentRemoteDirectory,
      value: question,
    }).then((completed) => {
      completeVerification(Boolean(completed), verificationTarget);
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

  const closePanel = () => {
    if (sending) void cancelRequest();
    setAuditVisible(false);
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
              onClick={() => {
                setAuditVisible(false);
                openHistory();
              }}
              type="text"
            />
          </Tooltip>
          <Tooltip content="操作审计">
            <Button
              aria-label="AI 操作审计"
              disabled={!sessionId}
              icon={<IconSafe />}
              onClick={() => {
                closeHistory();
                setAuditVisible(true);
              }}
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
          onInsertCommand={onInsertCommand}
          onInsertCommandProposal={confirmInsertCommandProposal}
          onOpenFileEditReview={openFileEditReview}
          onOpenFileOperationReview={openFileOperationReview}
          onRejectCommand={rejectCommandProposal}
          onRejectFileEdit={rejectFileEditProposal}
          onRejectFileOperation={rejectFileOperationProposal}
          onRerunTool={rerunTool}
          onRetryFileEdit={retryFileEditProposal}
          onRetryFileOperation={retryFileOperationProposal}
          onRetryMessage={retry}
          onRollbackAllFileEdits={confirmRollbackAllFileEdits}
          onRollbackAllFileOperations={confirmRollbackAllFileOperations}
          onRollbackFileEdit={confirmRollbackAppliedFileEdit}
          onRollbackFileOperation={confirmRollbackFileOperation}
          onSelectPreset={applyPromptPreset}
          onToggleToolRun={toggleToolRun}
          scrollRef={contentRef}
          sending={sending}
          sessionId={sessionId}
        />
        <AiComposer
          activeConversationAvailable={Boolean(activeConversation)}
          contextSources={contextSources}
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
        onApplyEdit={applyReviewedFileEdit}
        onApplyOperation={applyReviewedFileOperation}
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
      <AiAuditDrawer
        onClose={() => setAuditVisible(false)}
        visible={auditVisible}
      />
    </aside>
  );
}

export default AiAssistantPanel;
