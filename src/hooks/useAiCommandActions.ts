import { useEffect, useState } from "react";
import {
  markAiCommandProposalInserted,
  markAiCommandProposalVerified,
  type AiCommandProposal,
} from "../ai-command-proposals";
import { appendAiContextMentions, type AiContextSource } from "../ai-utils";
import { commandErrorMessage } from "../tauri-protocol";

export interface AiCommandConfirmation {
  content: string;
  danger: boolean;
  onConfirm: () => void | Promise<void>;
  title: string;
}

export type AiCommandNotice = "error" | "info" | "success" | "warning";

interface CommandVerificationTarget {
  conversationId: string;
  draft: string;
  messageId: string;
  proposalId: string;
}

interface UseAiCommandActionsOptions {
  contextSources: AiContextSource[];
  conversationId?: string;
  hostId: string | null;
  onConfirm: (confirmation: AiCommandConfirmation) => void;
  onCopyText: (value: string) => Promise<void>;
  onInsertCommand: (command: string) => Promise<void>;
  onNotice: (type: AiCommandNotice, content: string) => void;
  sessionId: string | null;
  setDraft: (conversationId: string, value: string) => void;
  updateCommandProposal: (
    messageId: string,
    proposalId: string,
    update: (proposal: AiCommandProposal) => AiCommandProposal,
  ) => unknown;
  updateCommandProposalInConversation: (
    hostId: string,
    conversationId: string,
    messageId: string,
    proposalId: string,
    update: (proposal: AiCommandProposal) => AiCommandProposal,
  ) => unknown;
}

export function useAiCommandActions({
  contextSources,
  conversationId,
  hostId,
  onConfirm,
  onCopyText,
  onInsertCommand,
  onNotice,
  sessionId,
  setDraft,
  updateCommandProposal,
  updateCommandProposalInConversation,
}: UseAiCommandActionsOptions) {
  const [verificationTarget, setVerificationTarget] =
    useState<CommandVerificationTarget | null>(null);

  useEffect(() => {
    setVerificationTarget(null);
  }, [sessionId]);

  const updateDraft = (
    value: string,
    targetConversationId = conversationId,
  ) => {
    if (!targetConversationId) return;
    setVerificationTarget((current) =>
      current?.conversationId === targetConversationId &&
      current.draft !== value
        ? null
        : current,
    );
    setDraft(targetConversationId, value);
  };

  const insertCommandProposal = async (
    messageId: string,
    proposal: AiCommandProposal,
  ) => {
    if (proposal.status !== "pending") return;
    try {
      await onInsertCommand(proposal.command);
      updateCommandProposal(
        messageId,
        proposal.id,
        markAiCommandProposalInserted,
      );
    } catch (error) {
      onNotice("error", commandErrorMessage(error));
    }
  };

  const confirmInsertCommandProposal = (
    messageId: string,
    proposal: AiCommandProposal,
  ) => {
    if (proposal.assessment.risk === "safe") {
      void insertCommandProposal(messageId, proposal);
      return;
    }
    onConfirm({
      content:
        proposal.assessment.reason ?? "请确认命令内容及其影响后再填入终端。",
      danger: proposal.assessment.risk === "danger",
      onConfirm: () => insertCommandProposal(messageId, proposal),
      title:
        proposal.assessment.risk === "danger"
          ? "确认填入高风险命令"
          : "确认填入命令",
    });
  };

  const copyCommandProposal = async (command: string) => {
    try {
      await onCopyText(command);
      onNotice("success", "命令已复制");
    } catch (error) {
      onNotice("error", commandErrorMessage(error));
    }
  };

  const copyAllCommandProposals = async (proposals: AiCommandProposal[]) => {
    try {
      await onCopyText(
        proposals.map((proposal) => proposal.command).join("\n"),
      );
      onNotice("success", `已复制 ${proposals.length} 条命令`);
    } catch (error) {
      onNotice("error", commandErrorMessage(error));
    }
  };

  const prepareCommandVerification = (
    messageId: string,
    proposal: AiCommandProposal,
  ) => {
    if (
      !conversationId ||
      (proposal.status !== "executed" &&
        proposal.status !== "succeeded" &&
        proposal.status !== "failed")
    ) {
      return;
    }
    if (proposal.sessionId !== sessionId) {
      onNotice("warning", "请切换到提交该命令的终端会话");
      return;
    }
    const resultSource = contextSources.find(
      (source) => source.id === `terminal-command-result:${proposal.id}`,
    );
    const source = resultSource?.content.trim()
      ? resultSource
      : contextSources.find((item) => item.id === "terminal-output");
    if (!source?.content.trim()) {
      onNotice("warning", "暂无可分析的命令输出");
      return;
    }
    const nextDraft = appendAiContextMentions(
      `请分析刚才提交的命令是否达到“${proposal.purpose}”的预期，并根据输出给出结论和下一步验证建议。`,
      contextSources,
      [source.id],
    );
    updateDraft(nextDraft, conversationId);
    setVerificationTarget({
      conversationId,
      draft: nextDraft,
      messageId,
      proposalId: proposal.id,
    });
    onNotice(
      "info",
      resultSource
        ? "已加入该命令的执行结果，确认问题后发送即可分析"
        : "已加入最近终端输出，确认问题后发送即可分析",
    );
  };

  const captureVerificationTarget = (draft: string) => {
    if (
      !verificationTarget ||
      verificationTarget.conversationId !== conversationId ||
      verificationTarget.draft !== draft
    ) {
      return null;
    }
    return verificationTarget;
  };

  const completeVerification = (
    completed: boolean,
    target: CommandVerificationTarget | null,
  ) => {
    if (!completed || !hostId || !target) return;
    updateCommandProposalInConversation(
      hostId,
      target.conversationId,
      target.messageId,
      target.proposalId,
      markAiCommandProposalVerified,
    );
    setVerificationTarget((current) =>
      current?.proposalId === target.proposalId ? null : current,
    );
  };

  return {
    captureVerificationTarget,
    completeVerification,
    confirmInsertCommandProposal,
    copyAllCommandProposals,
    copyCommandProposal,
    prepareCommandVerification,
    updateDraft,
  };
}
