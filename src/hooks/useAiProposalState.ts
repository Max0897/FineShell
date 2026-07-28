import { useCallback, useEffect, useRef } from "react";
import {
  aiCommandProposalMatchesSubmission,
  aiCommandProposalMatchesResult,
  markAiCommandProposalCompleted,
  markAiCommandProposalExecuted,
  type AiCommandProposal,
} from "../ai-command-proposals";
import type { AiFileEditProposal } from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import type { TerminalCommandSubmission } from "../terminal-utils";
import type { AiConversation, AiMessage } from "./useAiConversations";

type UpdateMessages = (
  hostId: string,
  conversationId: string,
  update: (messages: AiMessage[]) => AiMessage[],
) => AiConversation | undefined;

interface UseAiProposalStateOptions {
  activeConversationId?: string;
  commandSubmission: TerminalCommandSubmission | null;
  conversationsByHost: Record<string, AiConversation[]>;
  getHostConversations: (hostId: string) => AiConversation[];
  hostId: string | null;
  isHostLoaded: (hostId: string) => boolean;
  persistConversation: (conversation?: AiConversation) => Promise<void>;
  updateMessages: UpdateMessages;
}

export function useAiProposalState({
  activeConversationId,
  commandSubmission,
  conversationsByHost,
  getHostConversations,
  hostId,
  isHostLoaded,
  persistConversation,
  updateMessages,
}: UseAiProposalStateOptions) {
  const processedCommandSubmissionsRef = useRef(new Set<string>());

  const persistUpdatedMessages = useCallback(
    (
      targetHostId: string,
      targetConversationId: string,
      update: (messages: AiMessage[]) => AiMessage[],
    ) => {
      const updated = updateMessages(
        targetHostId,
        targetConversationId,
        update,
      );
      void persistConversation(updated);
      return updated;
    },
    [persistConversation, updateMessages],
  );

  const updateCommandProposalInConversation = useCallback(
    (
      targetHostId: string,
      targetConversationId: string,
      messageId: string,
      proposalId: string,
      update: (proposal: AiCommandProposal) => AiCommandProposal,
    ) =>
      persistUpdatedMessages(targetHostId, targetConversationId, (messages) =>
        messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                commandProposals: message.commandProposals?.map((proposal) =>
                  proposal.id === proposalId ? update(proposal) : proposal,
                ),
              }
            : message,
        ),
      ),
    [persistUpdatedMessages],
  );

  const updateCommandProposal = useCallback(
    (
      messageId: string,
      proposalId: string,
      update: (proposal: AiCommandProposal) => AiCommandProposal,
    ) => {
      if (!hostId || !activeConversationId) return undefined;
      return updateCommandProposalInConversation(
        hostId,
        activeConversationId,
        messageId,
        proposalId,
        update,
      );
    },
    [activeConversationId, hostId, updateCommandProposalInConversation],
  );

  const updateFileEditProposal = useCallback(
    (
      messageId: string,
      proposalId: string,
      update: (proposal: AiFileEditProposal) => AiFileEditProposal,
    ) => {
      if (!hostId || !activeConversationId) return undefined;
      return persistUpdatedMessages(hostId, activeConversationId, (messages) =>
        messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                fileEditProposals: message.fileEditProposals?.map((proposal) =>
                  proposal.id === proposalId ? update(proposal) : proposal,
                ),
              }
            : message,
        ),
      );
    },
    [activeConversationId, hostId, persistUpdatedMessages],
  );

  const updateFileOperationProposal = useCallback(
    (
      messageId: string,
      proposalId: string,
      update: (proposal: AiFileOperationProposal) => AiFileOperationProposal,
    ) => {
      if (!hostId || !activeConversationId) return undefined;
      return persistUpdatedMessages(hostId, activeConversationId, (messages) =>
        messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                fileOperationProposals: message.fileOperationProposals?.map(
                  (proposal) =>
                    proposal.id === proposalId ? update(proposal) : proposal,
                ),
              }
            : message,
        ),
      );
    },
    [activeConversationId, hostId, persistUpdatedMessages],
  );

  const rejectCommandProposal = useCallback(
    (messageId: string, proposalId: string) =>
      updateCommandProposal(messageId, proposalId, (proposal) => ({
        ...proposal,
        status: "rejected",
      })),
    [updateCommandProposal],
  );

  const rejectFileEditProposal = useCallback(
    (messageId: string, proposalId: string) =>
      updateFileEditProposal(messageId, proposalId, (proposal) => ({
        ...proposal,
        status: "rejected",
      })),
    [updateFileEditProposal],
  );

  const retryFileEditProposal = useCallback(
    (messageId: string, proposalId: string) =>
      updateFileEditProposal(messageId, proposalId, (proposal) => ({
        ...proposal,
        error: undefined,
        status: "pending",
      })),
    [updateFileEditProposal],
  );

  const rejectFileOperationProposal = useCallback(
    (messageId: string, proposalId: string) =>
      updateFileOperationProposal(messageId, proposalId, (proposal) => ({
        ...proposal,
        status: "rejected",
      })),
    [updateFileOperationProposal],
  );

  const retryFileOperationProposal = useCallback(
    (messageId: string, proposalId: string) =>
      updateFileOperationProposal(messageId, proposalId, (proposal) => ({
        ...proposal,
        error: undefined,
        status: "pending",
      })),
    [updateFileOperationProposal],
  );

  useEffect(() => {
    const submission = commandSubmission;
    const phase = submission?.phase ?? "submitted";
    const eventKey = submission ? `${submission.id}:${phase}` : "";
    if (
      !submission ||
      processedCommandSubmissionsRef.current.has(eventKey) ||
      !isHostLoaded(submission.hostId)
    ) {
      return;
    }
    processedCommandSubmissionsRef.current.add(eventKey);

    const conversations = getHostConversations(submission.hostId);
    for (const conversation of conversations) {
      for (
        let messageIndex = conversation.messages.length - 1;
        messageIndex >= 0;
        messageIndex -= 1
      ) {
        const message = conversation.messages[messageIndex];
        if (!message?.commandProposals?.length) continue;
        const proposal = [...message.commandProposals]
          .reverse()
          .find((item) =>
            phase === "submitted"
              ? aiCommandProposalMatchesSubmission(item, submission)
              : aiCommandProposalMatchesResult(item, submission) ||
                aiCommandProposalMatchesSubmission(item, submission),
          );
        if (!proposal) continue;
        updateCommandProposalInConversation(
          submission.hostId,
          conversation.id,
          message.id,
          proposal.id,
          (current) => {
            if (phase === "submitted") {
              return markAiCommandProposalExecuted(current, submission);
            }
            const executed =
              current.status === "inserted"
                ? markAiCommandProposalExecuted(current, submission)
                : current;
            return markAiCommandProposalCompleted(executed, submission);
          },
        );
        return;
      }
    }
  }, [
    commandSubmission,
    conversationsByHost,
    getHostConversations,
    isHostLoaded,
    updateCommandProposalInConversation,
  ]);

  return {
    rejectCommandProposal,
    rejectFileEditProposal,
    rejectFileOperationProposal,
    retryFileEditProposal,
    retryFileOperationProposal,
    updateCommandProposal,
    updateCommandProposalInConversation,
    updateFileEditProposal,
    updateFileOperationProposal,
  };
}
