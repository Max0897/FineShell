import { useEffect, useState } from "react";
import {
  markAiCommandProposalApproved,
  markAiCommandProposalUnavailable,
  markAiCommandProposalVerified,
  reconcileAiCommandProposalExecution,
  type AiCommandProposal,
} from "../ai-command-proposals";
import type { TerminalCommandSubmission } from "../terminal-utils";
import { appendAiContextMentions, type AiContextSource } from "../ai-utils";
import { commandErrorMessage } from "../tauri-protocol";

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
  onCopyText: (value: string) => Promise<void>;
  onPrepareCommand: (
    messageId: string,
    proposal: AiCommandProposal,
    userConfirmed: boolean,
  ) => Promise<TerminalCommandSubmission>;
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
  onCopyText,
  onPrepareCommand,
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

  const approveCommandProposal = async (
    messageId: string,
    proposal: AiCommandProposal,
    userConfirmed = true,
  ) => {
    if (proposal.status !== "pending") return false;
    updateCommandProposal(messageId, proposal.id, (current) =>
      markAiCommandProposalApproved(current),
    );
    try {
      const submission = await onPrepareCommand(
        messageId,
        proposal,
        userConfirmed,
      );
      updateCommandProposal(messageId, proposal.id, (current) =>
        reconcileAiCommandProposalExecution(current, {
          submissionId: submission.id,
          phase:
            submission.phase === "unavailable"
              ? submission.reason?.includes("取消")
                ? "interrupted"
                : "failed"
              : submission.exitCode === 0
                ? "completed"
                : "failed",
          outputExcerpt: submission.output ?? null,
          outputTruncated: submission.outputTruncated === true,
          ...(submission.stdout !== undefined || submission.stderr !== undefined
            ? {
                stdoutExcerpt: submission.stdout ?? null,
                stdoutTruncated: submission.stdoutTruncated === true,
                stderrExcerpt: submission.stderr ?? null,
                stderrTruncated: submission.stderrTruncated === true,
              }
            : {}),
          exitCode: submission.exitCode ?? null,
          durationMs: submission.durationMs ?? null,
          reason: submission.reason ?? null,
          submittedAt: Date.parse(submission.submittedAt),
          updatedAt: submission.completedAt
            ? Date.parse(submission.completedAt)
            : Date.now(),
          completedAt: submission.completedAt
            ? Date.parse(submission.completedAt)
            : Date.now(),
        }),
      );
      return submission;
    } catch (error) {
      updateCommandProposal(messageId, proposal.id, (current) =>
        markAiCommandProposalUnavailable(current, commandErrorMessage(error)),
      );
      onNotice("error", commandErrorMessage(error));
      return null;
    }
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
    approveCommandProposal,
    captureVerificationTarget,
    completeVerification,
    copyAllCommandProposals,
    copyCommandProposal,
    prepareCommandVerification,
    updateDraft,
  };
}
