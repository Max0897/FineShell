import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiConversationRecord } from "../ai-conversations";
import {
  useAiConversations,
  type AiConversation,
  type AiConversationStorage,
} from "./useAiConversations";

function conversation(
  id: string,
  hostId = "host-1",
  updatedAt = "2026-07-28T08:00:00.000Z",
): AiConversation {
  return {
    createdAt: updatedAt,
    hostId,
    hostName: `主机 ${hostId}`,
    id,
    messages: [
      {
        content: `问题 ${id}`,
        id: `message-${id}`,
        role: "user",
      },
    ],
    title: `对话 ${id}`,
    updatedAt,
  };
}

function memoryStorage(
  load: AiConversationStorage["load"] = async () => [],
) {
  const deleteConversation = mock(async () => undefined);
  const save = mock(async (value: AiConversationRecord) => value);
  return {
    deleteConversation,
    save,
    storage: {
      delete: deleteConversation,
      load,
      save,
    } satisfies AiConversationStorage,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useAiConversations", () => {
  test("creates an isolated fallback conversation and stores its draft", async () => {
    const { storage } = memoryStorage();
    const { result } = renderHook(() =>
      useAiConversations({
        hostId: "host-1",
        hostName: "生产服务器",
        sessionId: "session-1",
        storage,
      }),
    );

    await waitFor(() => expect(result.current.activeConversation).toBeDefined());
    const conversationId = result.current.activeConversation!.id;
    act(() => result.current.setDraft(conversationId, "检查系统状态"));

    expect(result.current.draft).toBe("检查系统状态");
    expect(result.current.hostConversations).toHaveLength(1);
    expect(result.current.activeConversation?.hostId).toBe("host-1");
  });

  test("keeps active conversation selection per terminal session", async () => {
    const records = [
      conversation("conversation-1", "host-1", "2026-07-28T08:00:00.000Z"),
      conversation("conversation-2", "host-1", "2026-07-28T07:00:00.000Z"),
    ];
    const { storage } = memoryStorage(async () => records);
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useAiConversations({
          hostId: "host-1",
          hostName: "生产服务器",
          sessionId,
          storage,
        }),
      { initialProps: { sessionId: "session-1" } },
    );

    await waitFor(() =>
      expect(result.current.activeConversationId).toBe("conversation-1"),
    );
    act(() => result.current.selectConversation("conversation-2"));
    expect(result.current.activeConversationId).toBe("conversation-2");

    rerender({ sessionId: "session-2" });
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe("conversation-1"),
    );
    rerender({ sessionId: "session-1" });
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe("conversation-2"),
    );
  });

  test("ignores an obsolete host load after the active host changes", async () => {
    const hostOne = deferred<AiConversationRecord[]>();
    const load = mock((hostId: string) =>
      hostId === "host-1"
        ? hostOne.promise
        : Promise.resolve([conversation("conversation-2", "host-2")]),
    );
    const { storage } = memoryStorage(load);
    const { result, rerender } = renderHook(
      ({ hostId }: { hostId: string }) =>
        useAiConversations({
          hostId,
          hostName: `主机 ${hostId}`,
          sessionId: "session-1",
          storage,
        }),
      { initialProps: { hostId: "host-1" } },
    );

    rerender({ hostId: "host-2" });
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe("conversation-2"),
    );
    await act(async () => {
      hostOne.resolve([conversation("conversation-1", "host-1")]);
      await hostOne.promise;
    });

    expect(result.current.activeConversation?.hostId).toBe("host-2");
    expect(result.current.getHostConversations("host-1")).toHaveLength(0);
  });

  test("serializes persistence writes", async () => {
    const firstSave = deferred<AiConversationRecord>();
    const save = mock((value: AiConversationRecord) =>
      value.id === "conversation-1"
        ? firstSave.promise
        : Promise.resolve(value),
    );
    const storage: AiConversationStorage = {
      delete: async () => undefined,
      load: async () => [],
      save,
    };
    const { result } = renderHook(() =>
      useAiConversations({
        hostId: "host-1",
        hostName: "生产服务器",
        sessionId: "session-1",
        storage,
      }),
    );
    const first = conversation("conversation-1");
    const second = conversation("conversation-2");

    const firstTask = result.current.persistConversation(first);
    const secondTask = result.current.persistConversation(second);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0].id).toBe("conversation-1");

    firstSave.resolve(conversation("conversation-1"));
    await Promise.all([firstTask, secondTask]);
    expect(save.mock.calls.map(([value]) => value.id)).toEqual([
      "conversation-1",
      "conversation-2",
    ]);
  });

  test("replaces the deleted final conversation with a local empty one", async () => {
    const existing = conversation("conversation-1");
    const { deleteConversation, storage } = memoryStorage(async () => [existing]);
    const { result } = renderHook(() =>
      useAiConversations({
        hostId: "host-1",
        hostName: "生产服务器",
        sessionId: "session-1",
        storage,
      }),
    );

    await waitFor(() =>
      expect(result.current.activeConversationId).toBe("conversation-1"),
    );
    await act(async () => {
      await result.current.removeConversation("conversation-1");
    });

    expect(deleteConversation).toHaveBeenCalledWith("conversation-1");
    expect(result.current.hostConversations).toHaveLength(1);
    expect(result.current.activeConversationId).not.toBe("conversation-1");
    expect(result.current.activeConversation?.messages).toEqual([]);
  });
});
