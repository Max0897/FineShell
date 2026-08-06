import {
  isValidElement,
  memo,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Button,
  Message,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCloud,
  IconCode,
  IconCommand,
  IconCopy,
  IconDashboard,
  IconDown,
  IconRefresh,
  IconRight,
  IconRobot,
} from "@arco-design/web-react/icon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiCommandProposal } from "../ai-command-proposals";
import type { AiFileEditProposal } from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import {
  AI_PROMPT_PRESETS,
  type AiPromptPreset,
  type AiPromptPresetId,
} from "../ai-presets";
import type { AiToolRun } from "../ai-tools";
import type { AiMessage } from "../hooks/useAiConversations";
import { commandErrorMessage } from "../tauri-protocol";
import AiCommandProposalList from "./AiCommandProposalList";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";
import AiFileChangePanels from "./AiFileChangePanels";
import AiToolRunList from "./AiToolRunList";

interface AiMessageTimelineProps {
  activeConversationAvailable: boolean;
  applyingFileChanges: boolean;
  canInsertCommand: boolean;
  dockedCommandProposalIds?: ReadonlySet<string>;
  dockedDiagnosticPlanIds?: ReadonlySet<string>;
  dockedFileEditProposalIds?: ReadonlySet<string>;
  dockedFileOperationProposalIds?: ReadonlySet<string>;
  expandedToolRuns: ReadonlySet<string>;
  hasRecentTerminalOutput: boolean;
  hostName: string;
  loading: boolean;
  messages: AiMessage[];
  onAddToolRunToDraft: (run: AiToolRun) => void;
  onAnalyzeCommand: (messageId: string, proposal: AiCommandProposal) => void;
  onApplyAllFileEdits: (
    messageId: string,
    proposals: AiFileEditProposal[],
  ) => void;
  onApplyAllFileOperations: (
    messageId: string,
    proposals: AiFileOperationProposal[],
  ) => void;
  onCopyCode: (value: string) => Promise<void>;
  onCopyCommand: (command: string) => void | Promise<void>;
  onCopyCommands: (proposals: AiCommandProposal[]) => void | Promise<void>;
  onCancelDiagnosticPlan: (planId: string) => void;
  onConfirmDiagnosticPlan: (planId: string, selectedCallIds: string[]) => void;
  onReviseDiagnosticPlan: (planId: string, feedback: string) => void;
  onApproveCommandProposal: (
    messageId: string,
    proposal: AiCommandProposal,
  ) => void | Promise<void>;
  onOpenFileEditReview: (
    messageId: string,
    proposal: AiFileEditProposal,
  ) => void;
  onOpenFileOperationReview: (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => void;
  onRejectCommand: (
    messageId: string,
    proposalId: string,
  ) => unknown | Promise<unknown>;
  onReviseCommand: (
    messageId: string,
    proposal: AiCommandProposal,
    feedback: string,
  ) => void | Promise<void>;
  onRejectFileEdit: (messageId: string, proposalId: string) => void;
  onRejectFileOperation: (messageId: string, proposalId: string) => void;
  onRetryFileEdit: (messageId: string, proposalId: string) => void;
  onRetryFileOperation: (messageId: string, proposalId: string) => void;
  onRetryMessage: (messageIndex: number) => void;
  onRollbackAllFileEdits: (
    messageId: string,
    proposals: AiFileEditProposal[],
  ) => void;
  onRollbackAllFileOperations: (
    messageId: string,
    proposals: AiFileOperationProposal[],
  ) => void;
  onRollbackFileEdit: (messageId: string, proposal: AiFileEditProposal) => void;
  onRollbackFileOperation: (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => void;
  onSelectPreset: (preset: AiPromptPreset) => void;
  onStopDiagnosticPlan: (planId: string) => void;
  onToggleToolRun: (key: string) => void;
  scrollRef: RefObject<HTMLDivElement>;
  sending: boolean;
  sessionId: string | null;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textContent(node.props.children);
  }
  return "";
}

function codeLanguage(node: ReactNode) {
  if (!isValidElement<{ className?: string }>(node)) return "";
  return (
    node.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase() ?? ""
  );
}

function isShellLanguage(language: string) {
  return (
    !language ||
    [
      "bash",
      "bat",
      "cmd",
      "console",
      "fish",
      "powershell",
      "sh",
      "shell",
      "zsh",
    ].includes(language)
  );
}

function promptPresetIcon(id: AiPromptPresetId) {
  switch (id) {
    case "explain-output":
      return <IconCode />;
    case "analyze-server":
      return <IconDashboard />;
    case "diagnose-network":
      return <IconCloud />;
    case "generate-command":
      return <IconCommand />;
  }
}

function containsOnlyDockedApproval(
  message: AiMessage,
  dockedCommandProposalIds?: ReadonlySet<string>,
  dockedDiagnosticPlanIds?: ReadonlySet<string>,
  dockedFileEditProposalIds?: ReadonlySet<string>,
  dockedFileOperationProposalIds?: ReadonlySet<string>,
) {
  if (
    message.role !== "assistant" ||
    message.content ||
    message.reasoning ||
    message.failed
  ) {
    return false;
  }
  const hasDockedCommand = message.commandProposals?.some((proposal) =>
    dockedCommandProposalIds?.has(proposal.id),
  );
  const hasDockedDiagnostic = message.diagnosticPlans?.some((plan) =>
    dockedDiagnosticPlanIds?.has(plan.id),
  );
  const hasDockedFileEdit = message.fileEditProposals?.some((proposal) =>
    dockedFileEditProposalIds?.has(proposal.id),
  );
  const hasDockedFileOperation = message.fileOperationProposals?.some(
    (proposal) => dockedFileOperationProposalIds?.has(proposal.id),
  );
  if (
    !hasDockedCommand &&
    !hasDockedDiagnostic &&
    !hasDockedFileEdit &&
    !hasDockedFileOperation
  ) {
    return false;
  }

  return !(
    message.commandProposals?.some(
      (proposal) => !dockedCommandProposalIds?.has(proposal.id),
    ) ||
    message.commandRecords?.length ||
    message.diagnosticPlans?.some(
      (plan) => !dockedDiagnosticPlanIds?.has(plan.id),
    ) ||
    message.toolRuns?.some((run) => !run.planId) ||
    message.fileEditProposals?.some(
      (proposal) => !dockedFileEditProposalIds?.has(proposal.id),
    ) ||
    message.fileOperationProposals?.some(
      (proposal) => !dockedFileOperationProposalIds?.has(proposal.id),
    ) ||
    message.fileChanges?.length
  );
}

function AiReasoningDisclosure({
  active,
  reasoning,
}: {
  active: boolean;
  reasoning: string;
}) {
  const [expanded, setExpanded] = useState(active);

  useEffect(() => {
    setExpanded(active);
  }, [active]);

  return (
    <div className={`ai-reasoning${active ? " ai-reasoning-active" : ""}`}>
      <Button
        aria-expanded={expanded}
        className="ai-reasoning-toggle"
        icon={expanded ? <IconDown /> : <IconRight />}
        onClick={() => setExpanded((current) => !current)}
        size="mini"
        type="text"
      >
        {active ? "正在思考..." : "思考过程"}
      </Button>
      {expanded && (
        <div className="ai-reasoning-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function messageIsActivelyThinking(
  message: AiMessage,
  index: number,
  messageCount: number,
  sending: boolean,
) {
  return (
    sending &&
    index === messageCount - 1 &&
    !message.content &&
    !message.failed &&
    !message.commandProposals?.length &&
    !message.fileEditProposals?.length &&
    !message.fileOperationProposals?.length &&
    !message.diagnosticPlans?.length &&
    !message.toolRuns?.length
  );
}

function messageHasActiveWorkflow(message: AiMessage) {
  return Boolean(
    message.commandProposals?.some(
      (proposal) =>
        proposal.status === "pending" ||
        proposal.status === "approved" ||
        proposal.status === "executed" ||
        proposal.executionPhase === "connecting" ||
        proposal.executionPhase === "running" ||
        proposal.executionPhase === "cancelling",
    ) ||
    message.diagnosticPlans?.some(
      (plan) => plan.status === "pending" || plan.status === "running",
    ) ||
    message.toolRuns?.some(
      (run) => run.status === "pending" || run.status === "running",
    ) ||
    message.fileEditProposals?.some(
      (proposal) => proposal.status === "pending",
    ) ||
    message.fileOperationProposals?.some(
      (proposal) => proposal.status === "pending",
    ),
  );
}

function messageIsActivelyStreaming(
  message: AiMessage,
  index: number,
  messageCount: number,
  sending: boolean,
) {
  if (
    !sending ||
    index !== messageCount - 1 ||
    message.role !== "assistant" ||
    message.failed ||
    messageHasActiveWorkflow(message)
  ) {
    return false;
  }
  return Boolean(message.content || !message.reasoning);
}

function AiStreamingIndicator() {
  return (
    <div
      aria-label="AI 正在生成"
      className="ai-streaming-indicator"
      role="status"
    >
      <span>正在生成</span>
      <span aria-hidden="true" className="ai-streaming-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function AiMarkdown({
  children,
  onCopyCode,
}: {
  children: string;
  onCopyCode: (value: string) => Promise<void>;
}) {
  return (
    <ReactMarkdown
      components={{
        pre: ({ children: codeNode }) => {
          const command = textContent(codeNode).trim();
          const language = codeLanguage(codeNode);
          const isCommand = isShellLanguage(language);
          return (
            <div className="ai-code-block">
              <div className="ai-code-block-header">
                <span className="ai-code-block-label">
                  {isCommand ? "命令建议" : "代码"}
                  <Tag size="small">
                    {isCommand ? "仅供查看" : language || "代码"}
                  </Tag>
                </span>
                <Space size="mini">
                  <Tooltip content="复制">
                    <Button
                      aria-label="复制代码"
                      icon={<IconCopy />}
                      onClick={() =>
                        void onCopyCode(command)
                          .then(() => Message.success("已复制"))
                          .catch((error) =>
                            Message.error(commandErrorMessage(error)),
                          )
                      }
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                </Space>
              </div>
              <pre>{codeNode}</pre>
            </div>
          );
        },
      }}
      remarkPlugins={[remarkGfm]}
    >
      {children}
    </ReactMarkdown>
  );
}

function AiMessageTimeline({
  activeConversationAvailable,
  applyingFileChanges,
  canInsertCommand,
  dockedCommandProposalIds,
  dockedDiagnosticPlanIds,
  dockedFileEditProposalIds,
  dockedFileOperationProposalIds,
  expandedToolRuns,
  hasRecentTerminalOutput,
  hostName,
  loading,
  messages,
  onAddToolRunToDraft,
  onAnalyzeCommand,
  onApplyAllFileEdits,
  onApplyAllFileOperations,
  onCopyCode,
  onCopyCommand,
  onCopyCommands,
  onCancelDiagnosticPlan,
  onConfirmDiagnosticPlan,
  onReviseDiagnosticPlan,
  onApproveCommandProposal,
  onOpenFileEditReview,
  onOpenFileOperationReview,
  onRejectCommand,
  onReviseCommand,
  onRejectFileEdit,
  onRejectFileOperation,
  onRetryFileEdit,
  onRetryFileOperation,
  onRetryMessage,
  onRollbackAllFileEdits,
  onRollbackAllFileOperations,
  onRollbackFileEdit,
  onRollbackFileOperation,
  onSelectPreset,
  onStopDiagnosticPlan,
  onToggleToolRun,
  scrollRef,
  sending,
  sessionId,
}: AiMessageTimelineProps) {
  return (
    <div className="ai-assistant-messages" ref={scrollRef}>
      {loading && !activeConversationAvailable ? (
        <Spin />
      ) : messages.length ? (
        messages.map((message, index) => {
          if (
            containsOnlyDockedApproval(
              message,
              dockedCommandProposalIds,
              dockedDiagnosticPlanIds,
              dockedFileEditProposalIds,
              dockedFileOperationProposalIds,
            )
          ) {
            return null;
          }
          return (
            <div
              className={`ai-message ai-message-${message.role}`}
              key={message.id}
            >
              <div className="ai-message-role">
                {message.role === "assistant" ? <IconRobot /> : null}
                <Typography.Text type="secondary">
                  {message.role === "assistant" ? "AI" : "你"}
                </Typography.Text>
                {message.contextLabels?.map((label) => (
                  <Tag key={label} size="small">
                    {label}
                  </Tag>
                ))}
              </div>
              {message.role === "assistant" && message.reasoning && (
                <AiReasoningDisclosure
                  active={messageIsActivelyThinking(
                    message,
                    index,
                    messages.length,
                    sending,
                  )}
                  reasoning={message.reasoning}
                />
              )}
              {message.role === "assistant" &&
                Boolean(
                  message.diagnosticPlans?.some(
                    (plan) => !dockedDiagnosticPlanIds?.has(plan.id),
                  ),
                ) && (
                  <AiDiagnosticPlanList
                    expandedRuns={expandedToolRuns}
                    messageId={message.id}
                    onAddToDraft={onAddToolRunToDraft}
                    onCancel={onCancelDiagnosticPlan}
                    onConfirm={onConfirmDiagnosticPlan}
                    onRevise={onReviseDiagnosticPlan}
                    onStop={onStopDiagnosticPlan}
                    onToggleRun={onToggleToolRun}
                    plans={(message.diagnosticPlans ?? []).filter(
                      (plan) => !dockedDiagnosticPlanIds?.has(plan.id),
                    )}
                    runs={message.toolRuns ?? []}
                    sending={sending}
                  />
                )}
              {message.role === "assistant" &&
                Boolean(message.toolRuns?.some((run) => !run.planId)) && (
                  <AiToolRunList
                    expandedRuns={expandedToolRuns}
                    messageId={message.id}
                    onAddToDraft={onAddToolRunToDraft}
                    onToggle={onToggleToolRun}
                    runs={message.toolRuns?.filter((run) => !run.planId) ?? []}
                    sending={sending}
                  />
                )}
              {message.role === "assistant" && (
                <AiCommandProposalList
                  canInsertCommand={canInsertCommand}
                  hasRecentTerminalOutput={hasRecentTerminalOutput}
                  hostName={hostName}
                  onApprove={(proposal) =>
                    onApproveCommandProposal(message.id, proposal)
                  }
                  onAnalyze={(proposal) =>
                    onAnalyzeCommand(message.id, proposal)
                  }
                  onCopy={onCopyCommand}
                  onCopyAll={onCopyCommands}
                  onReject={(proposalId) =>
                    onRejectCommand(message.id, proposalId)
                  }
                  onRevise={(proposal, feedback) =>
                    onReviseCommand(message.id, proposal, feedback)
                  }
                  proposals={message.commandProposals?.filter(
                    (proposal) => !dockedCommandProposalIds?.has(proposal.id),
                  )}
                  records={message.commandRecords}
                  sending={sending}
                  sessionId={sessionId}
                />
              )}
              {message.role === "assistant" && (
                <AiFileChangePanels
                  applying={applyingFileChanges}
                  changes={message.fileChanges}
                  editProposals={message.fileEditProposals?.filter(
                    (proposal) => !dockedFileEditProposalIds?.has(proposal.id),
                  )}
                  onApplyAllEdits={(proposals) =>
                    onApplyAllFileEdits(message.id, proposals)
                  }
                  onApplyAllOperations={(proposals) =>
                    onApplyAllFileOperations(message.id, proposals)
                  }
                  onOpenEditReview={(proposal) =>
                    onOpenFileEditReview(message.id, proposal)
                  }
                  onOpenOperationReview={(proposal) =>
                    onOpenFileOperationReview(message.id, proposal)
                  }
                  onRejectEdit={(proposalId) =>
                    onRejectFileEdit(message.id, proposalId)
                  }
                  onRejectOperation={(proposalId) =>
                    onRejectFileOperation(message.id, proposalId)
                  }
                  onRetryEdit={(proposalId) =>
                    onRetryFileEdit(message.id, proposalId)
                  }
                  onRetryOperation={(proposalId) =>
                    onRetryFileOperation(message.id, proposalId)
                  }
                  onRollbackAllEdits={(proposals) =>
                    onRollbackAllFileEdits(message.id, proposals)
                  }
                  onRollbackAllOperations={(proposals) =>
                    onRollbackAllFileOperations(message.id, proposals)
                  }
                  onRollbackEdit={(proposal) =>
                    onRollbackFileEdit(message.id, proposal)
                  }
                  onRollbackOperation={(proposal) =>
                    onRollbackFileOperation(message.id, proposal)
                  }
                  operationProposals={message.fileOperationProposals?.filter(
                    (proposal) =>
                      !dockedFileOperationProposalIds?.has(proposal.id),
                  )}
                />
              )}
              <div className="ai-message-content">
                {message.role === "assistant" ? (
                  <>
                    {message.content && (
                      <AiMarkdown onCopyCode={onCopyCode}>
                        {message.content}
                      </AiMarkdown>
                    )}
                    {messageIsActivelyStreaming(
                      message,
                      index,
                      messages.length,
                      sending,
                    ) && <AiStreamingIndicator />}
                    {message.failed && (
                      <div className="ai-message-failure">
                        <Typography.Text type="error">
                          {message.error}
                        </Typography.Text>
                        <Button
                          icon={<IconRefresh />}
                          onClick={() => onRetryMessage(index)}
                          size="mini"
                          type="text"
                        >
                          重试
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  message.content
                )}
              </div>
            </div>
          );
        })
      ) : (
        <div className="ai-assistant-empty">
          <IconRobot className="ai-assistant-empty-icon" />
          <Typography.Text type="secondary">常用任务</Typography.Text>
          <div className="ai-prompt-presets">
            {AI_PROMPT_PRESETS.map((preset) => (
              <Button
                icon={promptPresetIcon(preset.id)}
                key={preset.id}
                onClick={() => onSelectPreset(preset)}
                type="secondary"
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(AiMessageTimeline);
