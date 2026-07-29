import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiCommandProposal } from "../ai-command-proposals";
import type { AiContextSource } from "../ai-utils";
import { useAiCommandActions } from "./useAiCommandActions";

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
  onPrepareCommand?: (
    messageId: string,
    proposal: AiCommandProposal,
    executionMode: "insert_only" | "submit",
  ) => Promise<void>;
}) {
  const onPrepareCommand = mock(
    options?.onPrepareCommand ?? (async () => undefined),
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
      onCopyText: async () => undefined,
      onPrepareCommand,
      onNotice,
      sessionId: "session-1",
      setDraft,
      updateCommandProposal,
      updateCommandProposalInConversation,
    }),
  );
  return {
    ...hook,
    onPrepareCommand,
    onNotice,
    setDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  };
}

describe("useAiCommandActions", () => {
  test("approves a proposal for immediate submission", async () => {
    const view = renderActions();
    const value = proposal();

    act(() => {
      void view.result.current.approveCommandProposal(
        "assistant-1",
        value,
        "submit",
      );
    });
    await waitFor(() => expect(view.onPrepareCommand).toHaveBeenCalledTimes(1));

    expect(view.onPrepareCommand).toHaveBeenCalledWith(
      "assistant-1",
      value,
      "submit",
    );
    expect(view.updateCommandProposal).toHaveBeenCalledWith(
      "assistant-1",
      value.id,
      expect.any(Function),
    );
  });

  test("uses the approval card click as confirmation for dangerous proposals", async () => {
    const view = renderActions();
    const value = proposal("danger");

    await act(async () => {
      await view.result.current.approveCommandProposal(
        "assistant-1",
        value,
        "insert_only",
      );
    });
    expect(view.onPrepareCommand).toHaveBeenCalledWith(
      "assistant-1",
      value,
      "insert_only",
    );
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

  test("prefers the captured command result over generic recent output", async () => {
    const resultSource: AiContextSource = {
      content: "退出码: 2\npermission denied",
      id: "terminal-command-result:command-1",
      label: "命令结果:重启 Nginx-mand",
    };
    const view = renderActions({ contextSources: [resultSource] });
    const value = {
      ...proposal("safe", "failed"),
      exitCode: 2,
      resultOutput: "permission denied",
    };

    act(() => {
      view.result.current.prepareCommandVerification("assistant-1", value);
    });
    await waitFor(() => expect(view.setDraft).toHaveBeenCalledTimes(1));
    expect(view.setDraft.mock.calls[0]?.[1]).toContain(
      "@命令结果:重启 Nginx-mand",
    );
    expect(view.onNotice).toHaveBeenCalledWith(
      "info",
      "已加入该命令的执行结果，确认问题后发送即可分析",
    );
  });
});
