import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiCommandProposal } from "../ai-command-proposals";
import type { AiContextSource } from "../ai-utils";
import {
  useAiCommandActions,
  type AiCommandConfirmation,
} from "./useAiCommandActions";

function proposal(
  risk: AiCommandProposal["assessment"]["risk"] = "safe",
  status: AiCommandProposal["status"] = "pending",
): AiCommandProposal {
  return {
    assessment: {
      canInsert: true,
      label: risk === "safe" ? "低风险" : "高风险",
      reason: risk === "safe" ? undefined : "命令会修改系统状态",
      risk,
    },
    command: "systemctl restart nginx",
    id: "command-1",
    purpose: "重启 Nginx",
    sessionId: "session-1",
    status,
  };
}

function renderActions(options?: {
  contextSources?: AiContextSource[];
  onConfirm?: (confirmation: AiCommandConfirmation) => void;
  onInsertCommand?: (command: string) => Promise<void>;
}) {
  const onInsertCommand = mock(
    options?.onInsertCommand ?? (async () => undefined),
  );
  const onNotice = mock(() => undefined);
  const setDraft = mock((_conversationId: string, _value: string) => undefined);
  const updateCommandProposal = mock(
    (
      _messageId: string,
      _proposalId: string,
      update: (value: AiCommandProposal) => AiCommandProposal,
    ) => update(proposal()),
  );
  const updateCommandProposalInConversation = mock(
    (
      _hostId: string,
      _conversationId: string,
      _messageId: string,
      _proposalId: string,
      update: (value: AiCommandProposal) => AiCommandProposal,
    ) => update(proposal("safe", "executed")),
  );
  const hook = renderHook(() =>
    useAiCommandActions({
      contextSources: options?.contextSources ?? [],
      conversationId: "conversation-1",
      hostId: "host-1",
      onConfirm: options?.onConfirm ?? (() => undefined),
      onCopyText: async () => undefined,
      onInsertCommand,
      onNotice,
      sessionId: "session-1",
      setDraft,
      updateCommandProposal,
      updateCommandProposalInConversation,
    }),
  );
  return {
    ...hook,
    onInsertCommand,
    onNotice,
    setDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  };
}

describe("useAiCommandActions", () => {
  test("inserts a safe proposal without executing it automatically", async () => {
    const view = renderActions();
    const value = proposal();

    act(() => {
      view.result.current.confirmInsertCommandProposal("assistant-1", value);
    });
    await waitFor(() => expect(view.onInsertCommand).toHaveBeenCalledTimes(1));

    expect(view.onInsertCommand).toHaveBeenCalledWith(value.command);
    expect(view.updateCommandProposal).toHaveBeenCalledWith(
      "assistant-1",
      value.id,
      expect.any(Function),
    );
  });

  test("requires confirmation before inserting a dangerous proposal", async () => {
    let confirmation: AiCommandConfirmation | undefined;
    const view = renderActions({
      onConfirm: (value) => {
        confirmation = value;
      },
    });
    const value = proposal("danger");

    act(() => {
      view.result.current.confirmInsertCommandProposal("assistant-1", value);
    });
    expect(view.onInsertCommand).not.toHaveBeenCalled();
    expect(confirmation).toEqual(
      expect.objectContaining({ danger: true, title: "确认填入高风险命令" }),
    );

    await act(async () => {
      await confirmation?.onConfirm();
    });
    expect(view.onInsertCommand).toHaveBeenCalledWith(value.command);
  });

  test("prepares and completes verification for the matching conversation", async () => {
    const terminalOutput: AiContextSource = {
      content: "nginx is active",
      id: "terminal-output",
      label: "最近终端输出",
    };
    const view = renderActions({ contextSources: [terminalOutput] });
    const value = proposal("safe", "executed");

    act(() => {
      view.result.current.prepareCommandVerification("assistant-1", value);
    });
    await waitFor(() => expect(view.setDraft).toHaveBeenCalledTimes(1));
    const draft = view.setDraft.mock.calls[0]?.[1] ?? "";
    const target = view.result.current.captureVerificationTarget(draft);
    expect(target).not.toBeNull();

    act(() => {
      view.result.current.completeVerification(true, target);
    });
    expect(view.updateCommandProposalInConversation).toHaveBeenCalledWith(
      "host-1",
      "conversation-1",
      "assistant-1",
      value.id,
      expect.any(Function),
    );
    expect(view.onNotice).toHaveBeenCalledWith(
      "info",
      "已加入最近终端输出，确认问题后发送即可分析",
    );
  });
});
