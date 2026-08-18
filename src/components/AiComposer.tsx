import { memo } from "react";
import {
  Button,
  Mentions,
  Modal,
  Progress,
  Select,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconFile,
  IconSearch,
  IconSend,
  IconStop,
} from "@arco-design/web-react/icon";
import {
  MAX_AI_REMOTE_FILES,
  aiRemoteFileContextSource,
  isAiRemoteFileContextSourceId,
  separateAiContextMentions,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
  type AiRequestTokenBudget,
} from "../ai-utils";
import type { AgentApprovalMode, AiRequestTelemetry } from "../tauri-protocol";

const AI_APPROVAL_MODE_OPTIONS = [
  { label: "请求审批", value: "on_request" },
  { label: "替我审批", value: "auto_safe" },
  { label: "完全访问", value: "full_access" },
] satisfies { label: string; value: AgentApprovalMode }[];

interface AiComposerProps {
  activeConversationAvailable: boolean;
  approvalMode: AgentApprovalMode;
  canInsertCommand: boolean;
  contextSources: AiContextSource[];
  editableRemoteFileCount: number;
  fileEditEligibility?: string;
  model: string;
  lastTelemetry?: AiRequestTelemetry;
  onCancel: () => void | Promise<void>;
  onApprovalModeChange: (mode: AgentApprovalMode) => void;
  onChange: (value: string) => void;
  onRemoveRemoteFile: (file: AiRemoteFileContext) => void;
  onSend: () => void;
  onToggleRemoteFile: (file: AiRemoteFileContext, checked: boolean) => void;
  prompt: string;
  remoteFiles: AiRemoteFileContext[];
  selectedContextIds: AiContextSourceId[];
  sendEnabled: boolean;
  sending: boolean;
  tokenBudget: AiRequestTokenBudget;
}

function formatTokenCount(value: number) {
  if (value < 1_000) return String(value);
  const scaled = value / 1_000;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}k`;
}

function formatDuration(value: number) {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

function AiComposer({
  activeConversationAvailable,
  approvalMode,
  canInsertCommand,
  contextSources,
  editableRemoteFileCount,
  fileEditEligibility,
  lastTelemetry,
  model,
  onApprovalModeChange,
  onCancel,
  onChange,
  onRemoveRemoteFile,
  onSend,
  onToggleRemoteFile,
  prompt,
  remoteFiles,
  selectedContextIds,
  sendEnabled,
  sending,
  tokenBudget,
}: AiComposerProps) {
  const remoteFileContextBytes = remoteFiles.reduce(
    (total, file) => total + file.size,
    0,
  );
  const hasSelectedRemoteFile = selectedContextIds.some(
    isAiRemoteFileContextSourceId,
  );

  return (
    <div className="ai-assistant-composer">
      {remoteFiles.length > 0 && (
        <div className="ai-remote-file-contexts">
          <div className="ai-remote-file-contexts-heading">
            <Typography.Text type="secondary">文件上下文</Typography.Text>
            <Typography.Text type="secondary">
              {remoteFiles.length}/{MAX_AI_REMOTE_FILES} ·
              {Math.ceil(remoteFileContextBytes / 1024)}/512 KiB
            </Typography.Text>
          </div>
          <div className="ai-remote-file-context-list">
            {remoteFiles.map((file) => {
              const source = aiRemoteFileContextSource(file);
              const selected = selectedContextIds.includes(source.id);
              return (
                <Tooltip content={file.path} key={file.path}>
                  <Tag
                    checked={selected}
                    checkable
                    closable
                    icon={<IconFile />}
                    onCheck={(checked) => onToggleRemoteFile(file, checked)}
                    onClose={(event) => {
                      event.stopPropagation();
                      onRemoveRemoteFile(file);
                    }}
                    size="small"
                  >
                    {file.name}
                  </Tag>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
      <Mentions
        aria-label="向 AI 提问"
        autoSize={{ minRows: 3, maxRows: 7 }}
        className="ai-context-mentions"
        disabled={sending || !activeConversationAvailable}
        getPopupContainer={() => document.body}
        maxLength={4_000}
        notFoundContent={
          <span className="ai-context-mentions-empty">
            <IconSearch />
            <span>未找到相关上下文</span>
          </span>
        }
        onChange={(value) =>
          onChange(
            separateAiContextMentions(value, contextSources).slice(0, 4_000),
          )
        }
        onKeyDownCapture={(event) => {
          if (
            event.key !== "Enter" ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          ) {
            return;
          }

          const textarea = event.currentTarget;
          const selectionStart =
            textarea.selectionStart ?? textarea.value.length;
          const selectionEnd = textarea.selectionEnd ?? selectionStart;
          const textBeforeCursor = textarea.value.slice(0, selectionStart);
          const mentionIndex = textBeforeCursor.lastIndexOf("@");
          const mentionSearch =
            mentionIndex >= 0 ? textBeforeCursor.slice(mentionIndex + 1) : "";
          const mentionActive =
            mentionIndex >= 0 && !mentionSearch.includes(" ");

          if (!event.shiftKey && mentionActive) return;

          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            const nextValue = `${textarea.value.slice(
              0,
              selectionStart,
            )}\n${textarea.value.slice(selectionEnd)}`.slice(0, 4_000);
            const nextCursor = Math.min(selectionStart + 1, nextValue.length);
            onChange(nextValue);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(nextCursor, nextCursor);
            });
            return;
          }

          onSend();
        }}
        options={contextSources.map((source) => {
          const available = Boolean(source.content.trim());
          return {
            disabled: !available,
            label: (
              <span className="ai-context-mention-option">
                <span>{source.label}</span>
                <Typography.Text type="secondary">
                  {available
                    ? `${source.content.trim().length} 字符`
                    : "暂无内容"}
                </Typography.Text>
              </span>
            ),
            value: source.label,
          };
        })}
        placeholder="输入问题，@上下文"
        position="top"
        split=" "
        triggerProps={{ className: "ai-context-mentions-popup" }}
        value={prompt}
      />
      <div className="ai-assistant-composer-actions">
        <span className="ai-assistant-composer-meta">
          <Select
            aria-label="AI 审批模式"
            className={`ai-approval-mode ai-approval-mode-${approvalMode}`}
            disabled={!canInsertCommand || sending}
            onChange={(value) => {
              const next = value as AgentApprovalMode;
              if (next !== "full_access" || approvalMode === "full_access") {
                onApprovalModeChange(next);
                return;
              }
              Modal.confirm({
                cancelText: "取消",
                content:
                  "完全访问会自动执行 AI 提出的终端命令和文件操作，仅在当前主机和当前连接周期内生效。",
                okButtonProps: { status: "danger" },
                okText: "启用",
                onOk: () => onApprovalModeChange(next),
                title: "启用完全访问？",
              });
            }}
            options={AI_APPROVAL_MODE_OPTIONS}
            size="mini"
            value={approvalMode}
          />
          {hasSelectedRemoteFile && (
            <Tooltip content={fileEditEligibility ?? "修改前需要手动审阅确认"}>
              <Tag
                color={editableRemoteFileCount ? "green" : "gray"}
                size="small"
              >
                {editableRemoteFileCount
                  ? `可修改 ${editableRemoteFileCount} 个文件`
                  : "文件仅分析"}
              </Tag>
            </Tooltip>
          )}
          {tokenBudget.contextTruncated && (
            <Tooltip
              content={`已按 ${tokenBudget.contextLimitChars.toLocaleString()} 字符上限截断，部分上下文不会进入本次请求`}
            >
              <Tag color="orange" size="small">
                上下文已截断
              </Tag>
            </Tooltip>
          )}
        </span>
        <span className="ai-assistant-composer-submit">
          <Tooltip content={model || "未配置模型"}>
            <Typography.Text
              className="ai-assistant-composer-model"
              ellipsis
              type="secondary"
            >
              {model || "未配置模型"}
            </Typography.Text>
          </Tooltip>
          <Tooltip
            content={
              <div className="ai-token-budget-tooltip">
                <div>
                  对话历史：约 {formatTokenCount(tokenBudget.historyTokens)}{" "}
                  Token
                </div>
                <div>
                  当前输入：约 {formatTokenCount(tokenBudget.inputTokens)} Token
                </div>
                <div>
                  上下文：约 {formatTokenCount(tokenBudget.contextTokens)} Token
                </div>
                {tokenBudget.contextTruncated && (
                  <div>上下文已按设置上限截断</div>
                )}
                {lastTelemetry && (
                  <>
                    <div className="ai-token-budget-tooltip-heading">
                      上次响应
                    </div>
                    {lastTelemetry.usage ? (
                      <div>
                        实际 {formatTokenCount(lastTelemetry.usage.totalTokens)}{" "}
                        Token （输入{" "}
                        {formatTokenCount(lastTelemetry.usage.inputTokens)} /
                        输出{" "}
                        {formatTokenCount(lastTelemetry.usage.outputTokens)}）
                      </div>
                    ) : (
                      <div>供应商未返回 Token 用量</div>
                    )}
                    <div>
                      {lastTelemetry.requestCount} 次请求 ·{" "}
                      {formatDuration(lastTelemetry.durationMs)}
                    </div>
                  </>
                )}
              </div>
            }
          >
            <span
              aria-label={`本次请求约 ${tokenBudget.totalTokens} Token，上下文占用 ${tokenBudget.contextUsagePercent}%`}
              className="ai-token-budget"
            >
              <Progress
                percent={tokenBudget.contextUsagePercent}
                showText={false}
                size="mini"
                status={tokenBudget.contextTruncated ? "warning" : "normal"}
              />
            </span>
          </Tooltip>
          {sending ? (
            <Button
              icon={<IconStop />}
              onClick={() => void onCancel()}
              size="small"
            >
              停止
            </Button>
          ) : (
            <Button
              disabled={!sendEnabled}
              icon={<IconSend />}
              onClick={onSend}
              size="small"
              type="primary"
            >
              发送
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

export default memo(AiComposer);
