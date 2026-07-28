import { useEffect, useState } from "react";
import { commandErrorMessage } from "../tauri-protocol";
import type { AiConversation } from "./useAiConversations";

export interface AiConversationDeleteConfirmation {
  content: string;
  onConfirm: () => Promise<void>;
  title: string;
}

export interface AiConversationRenameRequest {
  initialValue: string;
  onConfirm: (value: string) => Promise<void>;
  title: string;
}

export type AiConversationNotice = "success" | "warning" | "error";

interface UseAiConversationActionsOptions {
  conversations: AiConversation[];
  createConversation: () => AiConversation | undefined;
  exportConversation: (conversation: AiConversation) => Promise<boolean>;
  hostId: string | null;
  onConfirmDelete: (
    confirmation: AiConversationDeleteConfirmation,
  ) => void;
  onNotice: (type: AiConversationNotice, content: string) => void;
  onRequestRename: (request: AiConversationRenameRequest) => void;
  removeConversation: (conversationId: string) => Promise<void>;
  renameConversation: (
    conversationId: string,
    title: string,
  ) => Promise<AiConversation | undefined>;
  selectConversation: (conversationId: string) => void;
  sending: boolean;
  sessionId: string | null;
}

export function useAiConversationActions({
  conversations,
  createConversation,
  exportConversation: exportConversationFile,
  hostId,
  onConfirmDelete,
  onNotice,
  onRequestRename,
  removeConversation: removeStoredConversation,
  renameConversation: renameStoredConversation,
  selectConversation: selectStoredConversation,
  sending,
  sessionId,
}: UseAiConversationActionsOptions) {
  const [historyVisible, setHistoryVisible] = useState(false);

  useEffect(() => {
    setHistoryVisible(false);
  }, [sessionId]);

  const historyConversations = conversations.filter(
    (conversation) => conversation.messages.length,
  );

  const findConversation = (conversationId: string) =>
    conversations.find((conversation) => conversation.id === conversationId);

  const closeHistory = () => setHistoryVisible(false);
  const openHistory = () => {
    if (!sessionId || sending) return;
    setHistoryVisible(true);
  };

  const newConversation = () => {
    if (!hostId || !sessionId || sending) return;
    createConversation();
    closeHistory();
  };

  const selectConversation = (conversationId: string) => {
    if (!sessionId || sending) return;
    selectStoredConversation(conversationId);
    closeHistory();
  };

  const renameConversation = (conversationId: string) => {
    if (!hostId || sending) return;
    const conversation = findConversation(conversationId);
    if (!conversation) return;
    onRequestRename({
      initialValue: conversation.title,
      onConfirm: async (value) => {
        const title = value.trim();
        if (!title) {
          onNotice("warning", "对话标题不能为空");
          return;
        }
        await renameStoredConversation(conversation.id, title);
      },
      title: "重命名对话",
    });
  };

  const removeConversation = (conversationId: string) => {
    if (!hostId || !sessionId || sending) return;
    const conversation = findConversation(conversationId);
    if (!conversation) return;
    onConfirmDelete({
      content: `删除“${conversation.title}”后无法恢复。`,
      onConfirm: async () => {
        try {
          await removeStoredConversation(conversation.id);
          closeHistory();
        } catch (error) {
          onNotice("error", `删除失败：${commandErrorMessage(error)}`);
          throw error;
        }
      },
      title: "删除对话",
    });
  };

  const exportConversation = async (conversationId: string) => {
    const conversation = findConversation(conversationId);
    if (!conversation) return;
    try {
      const exported = await exportConversationFile(conversation);
      if (exported) onNotice("success", "对话已导出");
    } catch (error) {
      onNotice("error", `导出失败：${commandErrorMessage(error)}`);
    }
  };

  return {
    closeHistory,
    exportConversation,
    historyConversations,
    historyVisible,
    newConversation,
    openHistory,
    removeConversation,
    renameConversation,
    selectConversation,
  };
}
