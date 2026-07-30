import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiCommandProposal } from "../ai-command-proposals";
import type { AiFileEditProposal } from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import type { TerminalCommandSubmission } from "../terminal-utils";
import type { AiConversation, AiMessage } from "./useAiConversations";
import { useAiProposalState } from "./useAiProposalState";

function commandProposal(
  status: AiCommandProposal["status"] = "pending",
): AiCommandProposal {
  return {
    assessment: { canInsert: true, label: "低风险", risk: "safe" },
    command: "ls -la",
    id: "command-1",
    purpose: "查看目录",
    sessionId: "session-1",
    status,
  };
}

function fileEditProposal(): AiFileEditProposal {
  return {
    content: "updated\n",
    error: "写入失败",
    id: "edit-1",
    originalFile: {
      content: "original\n",
      name: "app.conf",
      path: "/srv/app.conf",
      size: 9,
    },
    sessionId: "session-1",
    status: "failed",
  };
}

function fileOperationProposal(): AiFileOperationProposal {
  return {
    content: "value\n",
    error: "创建失败",
    id: "operation-1",
    operation: "create",
    path: "/srv/new.conf",
    sessionId: "session-1",
    status: "failed",
  };
}

function conversation(messages: AiMessage[]): AiConversation {
  return {
    createdAt: "2026-07-28T08:00:00.000Z",
    hostId: "host-1",
    hostName: "生产服务器",
    id: "conversation-1",
    messages,
    title: "检查服务器",
    updatedAt: "2026-07-28T08:00:00.000Z",
  };
}

function createHarness(initial: AiConversation) {
  let current = initial;
  const updateMessages = mock(
    (
      _hostId: string,
      _conversationId: string,
      update: (messages: AiMessage[]) => AiMessage[],
    ) => {
      current = { ...current, messages: update(current.messages) };
      return current;
    },
  );
  return {
    current: () => current,
    getHostConversations: () => [current],
    updateMessages,
  };
}

describe("useAiProposalState", () => {
  test("owns retry and rejection transitions for the active conversation", async () => {
    const harness = createHarness(
      conversation([
        {
          commandProposals: [commandProposal()],
          content: "",
          fileEditProposals: [fileEditProposal()],
          fileOperationProposals: [fileOperationProposal()],
          id: "assistant-1",
          role: "assistant",
        },
      ]),
    );
    const persistConversation = mock(async () => undefined);
    const { result } = renderHook(() =>
      useAiProposalState({
        activeConversationId: "conversation-1",
        commandSubmission: null,
        conversationsByHost: { "host-1": [harness.current()] },
        getHostConversations: harness.getHostConversations,
        hostId: "host-1",
        isHostLoaded: () => true,
        onActionTransition: async () => undefined,
        onActionTransitionError: () => undefined,
        onCommandLifecycleObserved: async () => undefined,
        persistConversation,
        updateMessages: harness.updateMessages,
      }),
    );

    await act(async () => {
      await Promise.all([
        result.current.rejectCommandProposal("assistant-1", "command-1"),
        result.current.retryFileEditProposal("assistant-1", "edit-1"),
        result.current.retryFileOperationProposal("assistant-1", "operation-1"),
      ]);
    });

    const message = harness.current().messages[0];
    expect(message?.commandProposals?.[0]?.status).toBe("rejected");
    expect(message?.fileEditProposals?.[0]).toEqual(
      expect.objectContaining({ error: undefined, status: "pending" }),
    );
    expect(message?.fileOperationProposals?.[0]).toEqual(
      expect.objectContaining({ error: undefined, status: "pending" }),
    );
    expect(persistConversation).toHaveBeenCalledTimes(3);
  });

  test("matches a terminal submission against the newest approved proposal", async () => {
    const approved = commandProposal("approved");
    const harness = createHarness(
      conversation([
        {
          commandProposals: [approved],
          content: "",
          id: "assistant-1",
          role: "assistant",
        },
      ]),
    );
    const submission: TerminalCommandSubmission = {
      command: "ls -la",
      hostId: "host-1",
      id: "submission-1",
      sessionId: "session-1",
      submittedAt: "2026-07-28T09:00:00.000Z",
    };
    const persistConversation = mock(async () => undefined);
    const observeCommandLifecycle = mock(async () => undefined);

    renderHook(() =>
      useAiProposalState({
        activeConversationId: "conversation-1",
        commandSubmission: submission,
        conversationsByHost: { "host-1": [harness.current()] },
        getHostConversations: harness.getHostConversations,
        hostId: "host-1",
        isHostLoaded: () => true,
        onActionTransition: async () => undefined,
        onActionTransitionError: () => undefined,
        onCommandLifecycleObserved: observeCommandLifecycle,
        persistConversation,
        updateMessages: harness.updateMessages,
      }),
    );

    await waitFor(() =>
      expect(harness.current().messages[0]?.commandProposals?.[0]).toEqual(
        expect.objectContaining({
          executedAt: submission.submittedAt,
          status: "executed",
        }),
      ),
    );
    expect(observeCommandLifecycle).toHaveBeenCalledWith(
      "assistant-1",
      "command-1",
      submission,
    );
    expect(persistConversation).toHaveBeenCalledTimes(1);
  });

  test("can complete an approved proposal when lifecycle events are batched", async () => {
    const harness = createHarness(
      conversation([
        {
          commandProposals: [commandProposal("approved")],
          content: "",
          id: "assistant-1",
          role: "assistant",
        },
      ]),
    );
    const result: TerminalCommandSubmission = {
      command: "ls -la",
      completedAt: "2026-07-28T09:00:02.000Z",
      durationMs: 2_000,
      exitCode: 0,
      hostId: "host-1",
      id: "submission-1",
      output: "file.txt",
      phase: "completed",
      sessionId: "session-1",
      submittedAt: "2026-07-28T09:00:00.000Z",
    };
    const observeCommandLifecycle = mock(async () => undefined);
    const onCommandLifecycleProcessed = mock(() => undefined);

    renderHook(() =>
      useAiProposalState({
        activeConversationId: "conversation-1",
        commandSubmission: result,
        conversationsByHost: { "host-1": [harness.current()] },
        getHostConversations: harness.getHostConversations,
        hostId: "host-1",
        isHostLoaded: () => true,
        onActionTransition: async () => undefined,
        onActionTransitionError: () => undefined,
        onCommandLifecycleObserved: observeCommandLifecycle,
        onCommandLifecycleProcessed,
        persistConversation: async () => undefined,
        updateMessages: harness.updateMessages,
      }),
    );

    await waitFor(() =>
      expect(harness.current().messages[0]?.commandProposals?.[0]).toEqual(
        expect.objectContaining({
          exitCode: 0,
          resultOutput: "file.txt",
          status: "succeeded",
          submissionId: "submission-1",
        }),
      ),
    );
    expect(observeCommandLifecycle).toHaveBeenCalledWith(
      "assistant-1",
      "command-1",
      result,
    );
    expect(onCommandLifecycleProcessed).toHaveBeenCalledWith(
      "command-1",
      result,
    );
  });
});
