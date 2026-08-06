import {
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconHistory, IconPlus } from "@arco-design/web-react/icon";

interface AiAssistantHeaderProps {
  conversationSummarized: boolean;
  conversationSummarizing: boolean;
  conversationTitle: string;
  disconnectedError?: string;
  onNew: () => void;
  onOpenHistory: () => void;
  sessionAvailable: boolean;
  sending: boolean;
}

export default function AiAssistantHeader({
  conversationSummarized,
  conversationSummarizing,
  conversationTitle,
  disconnectedError,
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
      </Space>
    </div>
  );
}
