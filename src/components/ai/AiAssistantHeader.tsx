import {
  Button,
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
import type { AgentApprovalMode } from "../../tauri-protocol";

const AI_APPROVAL_MODE_OPTIONS = [
  { label: "请求审批", value: "on_request" },
  { label: "替我审批", value: "auto_safe" },
  { label: "完全访问", value: "full_access" },
] satisfies { label: string; value: AgentApprovalMode }[];

interface AiAssistantHeaderProps {
  approvalMode: AgentApprovalMode;
  canInsertCommand: boolean;
  conversationAvailable: boolean;
  conversationSummarized: boolean;
  conversationSummarizing: boolean;
  conversationTitle: string;
  disconnectedError?: string;
  onApprovalModeChange: (mode: AgentApprovalMode) => void;
  onClose: () => void;
  onDelete: () => void;
  onNew: () => void;
  onOpenHistory: () => void;
  sessionAvailable: boolean;
  sending: boolean;
}

export default function AiAssistantHeader({
  approvalMode,
  canInsertCommand,
  conversationAvailable,
  conversationSummarized,
  conversationSummarizing,
  conversationTitle,
  disconnectedError,
  onApprovalModeChange,
  onClose,
  onDelete,
  onNew,
  onOpenHistory,
  sessionAvailable,
  sending,
}: AiAssistantHeaderProps) {
  return (
    <div className="panel-toolbar ai-assistant-title">
      <span className="ai-assistant-heading">
        <span>AI 助手</span>
        <Typography.Text ellipsis title={conversationTitle}>
          {conversationTitle}
        </Typography.Text>
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
        {conversationSummarizing ? (
          <Tooltip content="正在后台压缩较早的对话，不影响当前操作">
            <Tag color="arcoblue" size="small">
              整理中
            </Tag>
          </Tooltip>
        ) : conversationSummarized ? (
          <Tooltip content="较早对话已压缩为摘要，最近消息仍保留原文">
            <Tag size="small">已摘要</Tag>
          </Tooltip>
        ) : null}
        {disconnectedError !== undefined && (
          <Tooltip content={disconnectedError || "SSH 连接已断开，等待重连"}>
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
            disabled={!sessionAvailable || sending}
            icon={<IconPlus />}
            onClick={onNew}
            type="text"
          />
        </Tooltip>
        <Tooltip content="对话历史">
          <Button
            aria-label="对话历史"
            disabled={!sessionAvailable || sending}
            icon={<IconHistory />}
            onClick={onOpenHistory}
            type="text"
          />
        </Tooltip>
        <Tooltip content="删除当前对话">
          <Button
            aria-label="删除当前对话"
            disabled={!conversationAvailable || sending}
            icon={<IconDelete />}
            onClick={onDelete}
            type="text"
          />
        </Tooltip>
        <Button
          aria-label="关闭 AI 助手"
          icon={<IconClose />}
          onClick={onClose}
          type="text"
        />
      </Space>
    </div>
  );
}
