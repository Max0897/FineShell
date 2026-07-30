import { useCallback, useEffect, useRef } from "react";
import type { AiActionTransitionHandler } from "../ai-action-lifecycle";
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

type ObserveCommandLifecycle = (
  messageId: string,
  actionId: string,
  submission: TerminalCommandSubmission,
) => Promise<void>;

interface UseAiProposalStateOptions {
  activeConversationId?: string;
  commandSubmission: TerminalCommandSubmission | null;
  conversationsByHost: Record<string, AiConversation[]>;
  getHostConversations: (hostId: string) => AiConversation[];
  hostId: string | null;
  isHostLoaded: (hostId: string) => boolean;
  onActionTransition: AiActionTransitionHandler;
  onActionTransitionError: (error: unknown) => void;
  onCommandLifecycleObserved: ObserveCommandLifecycle;
  onCommandLifecycleProcessed?: (
    proposalId: string,
    submission: TerminalCommandSubmission,
  ) => void;
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
  onActionTransition,
  onActionTransitionError,
  onCommandLifecycleObserved,
  onCommandLifecycleProcessed,
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
    async (messageId: string, proposalId: string) => {
      try {
        await onActionTransition(messageId, proposalId, "reject");
        return updateCommandProposal(messageId, proposalId, (proposal) => ({
          ...proposal,
          status: "rejected",
        }));
      } catch (error) {
        onActionTransitionError(error);
        return undefined;
      }
    },
    [onActionTransition, onActionTransitionError, updateCommandProposal],
  );

  const rejectFileEditProposal = useCallback(
    async (messageId: string, proposalId: string) => {
      try {
        await onActionTransition(messageId, proposalId, "reject");
        return updateFileEditProposal(messageId, proposalId, (proposal) => ({
          ...proposal,
          status: "rejected",
        }));
      } catch (error) {
        onActionTransitionError(error);
        return undefined;
      }
    },
    [onActionTransition, onActionTransitionError, updateFileEditProposal],
  );

  const retryFileEditProposal = useCallback(
    async (messageId: string, proposalId: string) => {
      try {
        await onActionTransition(messageId, proposalId, "retry");
        return updateFileEditProposal(messageId, proposalId, (proposal) => ({
          ...proposal,
          error: undefined,
          status: "pending",
        }));
      } catch (error) {
        onActionTransitionError(error);
        return undefined;
      }
    },
    [onActionTransition, onActionTransitionError, updateFileEditProposal],
  );

  const rejectFileOperationProposal = useCallback(
    async (messageId: string, proposalId: string) => {
      try {
        await onActionTransition(messageId, proposalId, "reject");
        return updateFileOperationProposal(messageId, proposalId, (proposal) => ({
          ...proposal,
          status: "rejected",
        }));
      } catch (error) {
        onActionTransitionError(error);
        return undefined;
      }
    },
    [onActionTransition, onActionTransitionError, updateFileOperationProposal],
  );

  const retryFileOperationProposal = useCallback(
    async (messageId: string, proposalId: string) => {
      try {
        await onActionTransition(messageId, proposalId, "retry");
        return updateFileOperationProposal(messageId, proposalId, (proposal) => ({
          ...proposal,
          error: undefined,
          status: "pending",
        }));
      } catch (error) {
        onActionTransitionError(error);
        return undefined;
      }
    },
    [onActionTransition, onActionTransitionError, updateFileOperationProposal],
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
        void (async () => {
          try {
            await onCommandLifecycleObserved(
              message.id,
              proposal.id,
              submission,
            );
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
                  current.status === "approved"
                    ? markAiCommandProposalExecuted(current, submission)
                    : current;
                return markAiCommandProposalCompleted(executed, submission);
              },
            );
            onCommandLifecycleProcessed?.(proposal.id, submission);
          } catch (error) {
            processedCommandSubmissionsRef.current.delete(eventKey);
            onActionTransitionError(error);
          }
        })();
        return;
      }
    }
  }, [
    commandSubmission,
    conversationsByHost,
    getHostConversations,
    isHostLoaded,
    onActionTransitionError,
    onCommandLifecycleObserved,
    onCommandLifecycleProcessed,
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
