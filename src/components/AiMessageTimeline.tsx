import {
  isValidElement,
  memo,
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
  IconRefresh,
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
import { commandErrorMessage, type AgentTask } from "../tauri-protocol";
import AiCommandProposalList from "./AiCommandProposalList";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";
import AiFileChangePanels from "./AiFileChangePanels";
import AiToolRunList from "./AiToolRunList";
import AiTaskTimeline from "./AiTaskTimeline";

interface AiMessageTimelineProps {
  activeTask?: AgentTask;
  activeConversationAvailable: boolean;
  applyingFileChanges: boolean;
  canInsertCommand: boolean;
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
  onCopyToolRun: (run: AiToolRun) => void | Promise<void>;
  onCancelDiagnosticPlan: (planId: string) => void;
  onConfirmDiagnosticPlan: (
    planId: string,
    selectedCallIds: string[],
  ) => void;
  onInsertCommandProposal: (
    messageId: string,
    proposal: AiCommandProposal,
  ) => void;
  onOpenFileEditReview: (
    messageId: string,
    proposal: AiFileEditProposal,
  ) => void;
  onOpenFileOperationReview: (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => void;
  onRejectCommand: (messageId: string, proposalId: string) => void;
  onRejectFileEdit: (messageId: string, proposalId: string) => void;
  onRejectFileOperation: (messageId: string, proposalId: string) => void;
  onRerunTool: (messageId: string, run: AiToolRun) => void | Promise<void>;
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
  onRollbackFileEdit: (
    messageId: string,
    proposal: AiFileEditProposal,
  ) => void;
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
  return node.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase() ?? "";
}

function isShellLanguage(language: string) {
  return (
    !language ||
    ["bash", "bat", "cmd", "console", "fish", "powershell", "sh", "shell", "zsh"].includes(
      language,
    )
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
  activeTask,
  activeConversationAvailable,
  applyingFileChanges,
  canInsertCommand,
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
  onCopyToolRun,
  onCancelDiagnosticPlan,
  onConfirmDiagnosticPlan,
  onInsertCommandProposal,
  onOpenFileEditReview,
  onOpenFileOperationReview,
  onRejectCommand,
  onRejectFileEdit,
  onRejectFileOperation,
  onRerunTool,
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
      <AiTaskTimeline task={activeTask} />
      {loading && !activeConversationAvailable ? (
        <Spin />
      ) : messages.length ? (
        messages.map((message, index) => (
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
            {message.role === "assistant" &&
              Boolean(message.diagnosticPlans?.length) && (
                <AiDiagnosticPlanList
                  expandedRuns={expandedToolRuns}
                  messageId={message.id}
                  onAddToDraft={onAddToolRunToDraft}
                  onCancel={onCancelDiagnosticPlan}
                  onConfirm={onConfirmDiagnosticPlan}
                  onCopy={onCopyToolRun}
                  onRerun={onRerunTool}
                  onStop={onStopDiagnosticPlan}
                  onToggleRun={onToggleToolRun}
                  plans={message.diagnosticPlans ?? []}
                  runs={message.toolRuns ?? []}
                  sending={sending}
                  sessionAvailable={Boolean(sessionId)}
                />
              )}
            {message.role === "assistant" &&
              Boolean(message.toolRuns?.some((run) => !run.planId)) && (
              <AiToolRunList
                expandedRuns={expandedToolRuns}
                messageId={message.id}
                onAddToDraft={onAddToolRunToDraft}
                onCopy={onCopyToolRun}
                onRerun={onRerunTool}
                onToggle={onToggleToolRun}
                runs={message.toolRuns?.filter((run) => !run.planId) ?? []}
                sending={sending}
                sessionAvailable={Boolean(sessionId)}
              />
            )}
            {message.role === "assistant" && (
              <AiCommandProposalList
                canInsertCommand={canInsertCommand}
                hasRecentTerminalOutput={hasRecentTerminalOutput}
                hostName={hostName}
                onAnalyze={(proposal) => onAnalyzeCommand(message.id, proposal)}
                onCopy={onCopyCommand}
                onCopyAll={onCopyCommands}
                onInsert={(proposal) =>
                  onInsertCommandProposal(message.id, proposal)
                }
                onReject={(proposalId) =>
                  onRejectCommand(message.id, proposalId)
                }
                proposals={message.commandProposals}
                records={message.commandRecords}
                sending={sending}
                sessionId={sessionId}
              />
            )}
            {message.role === "assistant" && (
              <AiFileChangePanels
                applying={applyingFileChanges}
                changes={message.fileChanges}
                editProposals={message.fileEditProposals}
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
                operationProposals={message.fileOperationProposals}
              />
            )}
            <div className="ai-message-content">
              {message.role === "assistant" ? (
                <>
                  {message.content ? (
                    <AiMarkdown
                      onCopyCode={onCopyCode}
                    >
                      {message.content}
                    </AiMarkdown>
                  ) : message.failed ||
                    message.commandProposals?.length ||
                    message.commandRecords?.length ||
                    message.fileEditProposals?.length ||
                    message.fileOperationProposals?.length ||
                    message.fileChanges?.length ||
                    message.diagnosticPlans?.length ? null : message.toolRuns?.some(
                        (run) => run.status === "running",
                      ) ? null : (
                    <Spin size={14} />
                  )}
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
        ))
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
