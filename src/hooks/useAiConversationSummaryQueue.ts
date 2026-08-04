import { useCallback, useRef, useState } from "react";
import type { AppSettings } from "../app-settings";
import {
  sanitizeAiConversation,
  type AiConversationSummaryRecord,
} from "../ai-conversations";
import {
  completeAiConversationSummary,
  createAiConversationSummaryPlan,
} from "../ai-summaries";
import type {
  AiChatResult,
  TauriCommand,
} from "../tauri-protocol";
import { createAiRequestId } from "./ai-request-id";
import type { AiConversation } from "./useAiConversations";

type AiSummaryInvoke = <T>(
  command: TauriCommand,
  args?: Record<string, unknown>,
) => Promise<T>;

interface UseAiConversationSummaryQueueOptions {
  invoke: AiSummaryInvoke;
  onSummaryError?: (error: unknown) => void;
  persistConversation: (conversation?: AiConversation) => Promise<void>;
  settings: Pick<AppSettings, "aiBaseUrl" | "aiModel">;
  updateConversation: (
    hostId: string,
    conversationId: string,
    update: (conversation: AiConversation) => AiConversation,
  ) => AiConversation | undefined;
}

export function useAiConversationSummaryQueue({
  invoke,
  onSummaryError,
  persistConversation,
  settings,
  updateConversation,
}: UseAiConversationSummaryQueueOptions) {
  const [summarizingConversationIds, setSummarizingConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const summaryRequestsRef = useRef(new Set<string>());
  const onSummaryErrorRef = useRef(onSummaryError);
  onSummaryErrorRef.current = onSummaryError;

  const queueConversationSummary = useCallback(
    (conversation?: AiConversation) => {
      if (!conversation || summaryRequestsRef.current.has(conversation.id)) {
        return;
      }
      const sanitized = sanitizeAiConversation(conversation);
      if (!sanitized) return;
      const plan = createAiConversationSummaryPlan(sanitized);
      if (!plan) return;

      summaryRequestsRef.current.add(conversation.id);
      setSummarizingConversationIds((current) => {
        const next = new Set(current);
        next.add(conversation.id);
        return next;
      });

      void (async () => {
        try {
          const result = await invoke<AiChatResult>("ai_chat_start", {
            request: {
              requestId: createAiRequestId("ai-summary"),
              baseUrl: settings.aiBaseUrl,
              model: settings.aiModel,
              messages: [{ role: "user", content: plan.prompt }],
              context: null,
              enabledTools: [],
              fileEditEnabled: false,
              commandProposalEnabled: false,
              toolRounds: [],
            },
          });
          if (result.toolCalls.length) {
            throw new Error("对话摘要请求返回了不支持的工具调用");
          }
          const summary: AiConversationSummaryRecord =
            completeAiConversationSummary(plan, result.content);
          let applied = false;
          const updated = updateConversation(
            conversation.hostId,
            conversation.id,
            (current) => {
              if (
                current.summary?.throughMessageId !==
                plan.previousSummary?.throughMessageId
              ) {
                return current;
              }
              applied = true;
              return { ...current, summary };
            },
          );
          if (applied) await persistConversation(updated);
        } catch (error) {
          onSummaryErrorRef.current?.(error);
        } finally {
          summaryRequestsRef.current.delete(conversation.id);
          setSummarizingConversationIds((current) => {
            const next = new Set(current);
            next.delete(conversation.id);
            return next;
          });
        }
      })();
    }, [
      invoke,
      persistConversation,
      settings.aiBaseUrl,
      settings.aiModel,
      updateConversation,
    ],
  );

  return { queueConversationSummary, summarizingConversationIds };
}
