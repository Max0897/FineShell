import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  useAiConversationActions,
  type AiConversationDeleteConfirmation,
  type AiConversationRenameRequest,
} from "./useAiConversationActions";
import type { AiConversation } from "./useAiConversations";

function conversation(id: string): AiConversation {
  return {
    createdAt: "2026-07-28T08:00:00.000Z",
    hostId: "host-1",
    hostName: "生产服务器",
    id,
    messages: [
      {
        content: `问题 ${id}`,
        id: `message-${id}`,
        role: "user",
      },
    ],
    title: `对话 ${id}`,
    updatedAt: "2026-07-28T08:00:00.000Z",
  };
}

function renderActions(options?: {
  exportResult?: boolean;
  onConfirmDelete?: (
    confirmation: AiConversationDeleteConfirmation,
  ) => void;
  onRequestRename?: (request: AiConversationRenameRequest) => void;
}) {
  const createConversation = mock(() => conversation("new"));
  const exportConversation = mock(
    async (_conversation: AiConversation) => options?.exportResult ?? true,
  );
  const onNotice = mock(
    (_type: "success" | "warning" | "error", _content: string) => undefined,
  );
  const removeConversation = mock(async (_conversationId: string) => undefined);
  const renameConversation = mock(
    async (_conversationId: string, _title: string) => conversation("one"),
  );
  const selectConversation = mock((_conversationId: string) => undefined);
  const hook = renderHook(() =>
    useAiConversationActions({
      conversations: [conversation("one"), conversation("two")],
      createConversation,
      exportConversation,
      hostId: "host-1",
      onConfirmDelete: options?.onConfirmDelete ?? (() => undefined),
      onNotice,
      onRequestRename: options?.onRequestRename ?? (() => undefined),
      removeConversation,
      renameConversation,
      selectConversation,
      sending: false,
      sessionId: "session-1",
    }),
  );
  return {
    ...hook,
    createConversation,
    exportConversation,
    onNotice,
    removeConversation,
    renameConversation,
    selectConversation,
  };
}

describe("useAiConversationActions", () => {
  test("opens history and closes it after creating or selecting a conversation", () => {
    const view = renderActions();

    act(() => view.result.current.openHistory());
    expect(view.result.current.historyVisible).toBe(true);
    act(() => view.result.current.newConversation());
    expect(view.createConversation).toHaveBeenCalledTimes(1);
    expect(view.result.current.historyVisible).toBe(false);

    act(() => view.result.current.openHistory());
    act(() => view.result.current.selectConversation("two"));
    expect(view.selectConversation).toHaveBeenCalledWith("two");
    expect(view.result.current.historyVisible).toBe(false);
  });

  test("validates and saves a requested conversation rename", async () => {
    let request: AiConversationRenameRequest | undefined;
    const view = renderActions({
      onRequestRename: (value) => {
        request = value;
      },
    });

    act(() => view.result.current.renameConversation("one"));
    expect(request?.initialValue).toBe("对话 one");
    await act(async () => request?.onConfirm("   "));
    expect(view.renameConversation).not.toHaveBeenCalled();
    expect(view.onNotice).toHaveBeenCalledWith("warning", "对话标题不能为空");

    await act(async () => request?.onConfirm("  新标题  "));
    expect(view.renameConversation).toHaveBeenCalledWith("one", "新标题");
  });

  test("deletes after confirmation and does not report a cancelled export", async () => {
    let confirmation: AiConversationDeleteConfirmation | undefined;
    const view = renderActions({
      exportResult: false,
      onConfirmDelete: (value) => {
        confirmation = value;
      },
    });

    act(() => view.result.current.removeConversation("one"));
    expect(confirmation?.content).toContain("对话 one");
    await act(async () => confirmation?.onConfirm());
    expect(view.removeConversation).toHaveBeenCalledWith("one");

    await act(async () => view.result.current.exportConversation("one"));
    expect(view.exportConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one" }),
    );
    expect(view.onNotice).not.toHaveBeenCalledWith("success", "对话已导出");
  });
});
