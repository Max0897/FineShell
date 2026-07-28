import {
  Button,
  Drawer,
  Empty,
  Spin,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconEdit,
} from "@arco-design/web-react/icon";

export interface AiConversationHistoryItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface AiConversationHistoryDrawerProps {
  activeConversationId: string | null;
  conversations: AiConversationHistoryItem[];
  loading: boolean;
  onClose: () => void;
  onDelete: (conversationId: string) => void;
  onExport: (conversationId: string) => void | Promise<void>;
  onRename: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
  visible: boolean;
}

export function aiConversationTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

function AiConversationHistoryDrawer({
  activeConversationId,
  conversations,
  loading,
  onClose,
  onDelete,
  onExport,
  onRename,
  onSelect,
  visible,
}: AiConversationHistoryDrawerProps) {
  return (
    <Drawer
      bodyStyle={{ padding: 0 }}
      className="ai-conversation-history-drawer"
      footer={null}
      getChildrenPopupContainer={() => document.body}
      onCancel={onClose}
      title={
        <div className="ai-conversation-history-drawer-title">
          <span>对话历史</span>
          <Typography.Text type="secondary">
            {conversations.length} 条
          </Typography.Text>
        </div>
      }
      visible={visible}
      width={380}
    >
      <div className="ai-conversation-history">
        <div className="ai-conversation-history-list">
          {loading ? (
            <Spin />
          ) : conversations.length ? (
            conversations.map((conversation) => (
              <div
                className={`ai-conversation-history-item${
                  conversation.id === activeConversationId ? " is-active" : ""
                }`}
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(conversation.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className="ai-conversation-history-meta">
                  <Typography.Text>{conversation.title}</Typography.Text>
                  <Typography.Text type="secondary">
                    {aiConversationTime(conversation.updatedAt)}
                  </Typography.Text>
                </span>
                <span
                  className="ai-conversation-history-actions"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Tooltip content="重命名">
                    <Button
                      aria-label="重命名对话"
                      icon={<IconEdit />}
                      onClick={() => onRename(conversation.id)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                  <Tooltip content="导出 Markdown">
                    <Button
                      aria-label="导出对话"
                      icon={<IconDownload />}
                      onClick={() => void onExport(conversation.id)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                  <Tooltip content="删除">
                    <Button
                      aria-label="删除对话"
                      icon={<IconDelete />}
                      onClick={() => onDelete(conversation.id)}
                      size="mini"
                      status="danger"
                      type="text"
                    />
                  </Tooltip>
                </span>
              </div>
            ))
          ) : (
            <Empty description="暂无历史对话" />
          )}
        </div>
      </div>
    </Drawer>
  );
}

export default AiConversationHistoryDrawer;
