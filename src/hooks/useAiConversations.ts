import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiCommandProposal,
  AiCommandRecord,
} from "../ai-command-proposals";
import {
  deleteAiConversation,
  loadAiConversations,
  MAX_AI_CONVERSATIONS_PER_HOST,
  saveAiConversation,
  type AiConversationRecord,
} from "../ai-conversations";
import type {
  AiFileChangeRecord,
  AiFileEditProposal,
} from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import type { AiDiagnosticPlan } from "../ai-diagnostic-plans";
import type { AiToolRun } from "../ai-tools";
import type { AiRequestTelemetry } from "../tauri-protocol";

export interface AiMessage {
  commandProposals?: AiCommandProposal[];
  commandRecords?: AiCommandRecord[];
  content: string;
  context?: string;
  contextLabels?: string[];
  diagnosticPlans?: AiDiagnosticPlan[];
  error?: string;
  failed?: boolean;
  fileChanges?: AiFileChangeRecord[];
  fileEditProposals?: AiFileEditProposal[];
  fileOperationProposals?: AiFileOperationProposal[];
  id: string;
  reasoning?: string;
  role: "user" | "assistant";
  taskId?: string;
  telemetry?: AiRequestTelemetry;
  toolRuns?: AiToolRun[];
}

export interface AiConversation extends Omit<AiConversationRecord, "messages"> {
  messages: AiMessage[];
}

export interface AiConversationStorage {
  delete: (conversationId: string) => Promise<void>;
  load: (hostId: string) => Promise<AiConversationRecord[]>;
  save: (conversation: AiConversationRecord) => Promise<AiConversationRecord>;
}

interface UseAiConversationsOptions {
  hostId: string | null;
  hostName: string;
  onLoadError?: (error: unknown) => void;
  onSaveError?: (error: unknown) => void;
  sessionId: string | null;
  storage?: AiConversationStorage;
}

const DEFAULT_STORAGE: AiConversationStorage = {
  delete: deleteAiConversation,
  load: loadAiConversations,
  save: saveAiConversation,
};

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAiConversation(
  hostId: string,
  hostName: string,
): AiConversation {
  const now = new Date().toISOString();
  return {
    id: createId("ai-conversation"),
    hostId,
    hostName,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function sortAiConversations(conversations: AiConversation[]) {
  return [...conversations].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function useAiConversations({
  hostId,
  hostName,
  onLoadError,
  onSaveError,
  sessionId,
  storage = DEFAULT_STORAGE,
}: UseAiConversationsOptions) {
  const [conversationsByHost, setConversationsByHost] = useState<
    Record<string, AiConversation[]>
  >({});
  const conversationsRef = useRef<Record<string, AiConversation[]>>({});
  const loadedHostsRef = useRef(new Set<string>());
  const [activeConversationIds, setActiveConversationIds] = useState<
    Record<string, string>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const persistenceWarningRef = useRef(false);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const onLoadErrorRef = useRef(onLoadError);
  const onSaveErrorRef = useRef(onSaveError);
  onLoadErrorRef.current = onLoadError;
  onSaveErrorRef.current = onSaveError;

  const replaceHostConversations = useCallback(
    (
      targetHostId: string,
      update: (current: AiConversation[]) => AiConversation[],
    ) => {
      const nextHostConversations = sortAiConversations(
        update(conversationsRef.current[targetHostId] ?? []),
      ).slice(0, MAX_AI_CONVERSATIONS_PER_HOST);
      const next = {
        ...conversationsRef.current,
        [targetHostId]: nextHostConversations,
      };
      conversationsRef.current = next;
      setConversationsByHost(next);
      return nextHostConversations;
    },
    [],
  );

  const updateConversation = useCallback(
    (
      targetHostId: string,
      conversationId: string,
      update: (current: AiConversation) => AiConversation,
    ) => {
      let updated: AiConversation | undefined;
      replaceHostConversations(targetHostId, (current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          updated = update(conversation);
          return updated;
        }),
      );
      return updated;
    },
    [replaceHostConversations],
  );

  const updateMessages = useCallback(
    (
      targetHostId: string,
      conversationId: string,
      update: (current: AiMessage[]) => AiMessage[],
    ) =>
      updateConversation(targetHostId, conversationId, (current) => ({
        ...current,
        messages: update(current.messages),
      })),
    [updateConversation],
  );

  const persistConversation = useCallback(
    (conversation?: AiConversation) => {
      if (!conversation) return Promise.resolve();
      const task = persistenceQueueRef.current.then(async () => {
        try {
          await storage.save(conversation);
          persistenceWarningRef.current = false;
        } catch (error) {
          if (!persistenceWarningRef.current) {
            persistenceWarningRef.current = true;
            onSaveErrorRef.current?.(error);
          }
        }
      });
      persistenceQueueRef.current = task;
      return task;
    },
    [storage],
  );

  const activateAvailableConversation = useCallback(
    (
      targetHostId: string,
      targetHostName: string,
      targetSessionId: string,
    ) => {
      let available = conversationsRef.current[targetHostId] ?? [];
      if (!available.length) {
        available = replaceHostConversations(targetHostId, () => [
          createAiConversation(targetHostId, targetHostName),
        ]);
      }
      setActiveConversationIds((current) => {
        const selected = current[targetSessionId];
        if (selected && available.some((item) => item.id === selected)) {
          return current;
        }
        return { ...current, [targetSessionId]: available[0]!.id };
      });
    },
    [replaceHostConversations],
  );

  useEffect(() => {
    if (!hostId || !sessionId) {
      setLoading(false);
      return;
    }
    if (loadedHostsRef.current.has(hostId)) {
      setLoading(false);
      activateAvailableConversation(hostId, hostName, sessionId);
      return;
    }

    let disposed = false;
    setLoading(true);
    void storage
      .load(hostId)
      .then((records) => {
        if (disposed) return;
        loadedHostsRef.current.add(hostId);
        replaceHostConversations(hostId, () =>
          records.length
            ? records.map((record) => ({ ...record, messages: record.messages }))
            : [createAiConversation(hostId, hostName)],
        );
        activateAvailableConversation(hostId, hostName, sessionId);
      })
      .catch((error) => {
        if (disposed) return;
        loadedHostsRef.current.add(hostId);
        replaceHostConversations(hostId, () => [
          createAiConversation(hostId, hostName),
        ]);
        activateAvailableConversation(hostId, hostName, sessionId);
        onLoadErrorRef.current?.(error);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    activateAvailableConversation,
    hostId,
    hostName,
    replaceHostConversations,
    sessionId,
    storage,
  ]);

  const hostConversations = hostId
    ? conversationsByHost[hostId] ?? []
    : [];
  const activeConversationId = sessionId
    ? activeConversationIds[sessionId]
    : undefined;
  const activeConversation = hostConversations.find(
    (conversation) => conversation.id === activeConversationId,
  );
  const conversationId = activeConversation?.id;
  const draft = conversationId ? drafts[conversationId] ?? "" : "";

  const setDraft = useCallback((conversationId: string, value: string) => {
    setDrafts((current) => ({ ...current, [conversationId]: value }));
  }, []);

  const createAndActivateConversation = useCallback(() => {
    if (!hostId || !sessionId) return undefined;
    const conversation = createAiConversation(hostId, hostName);
    replaceHostConversations(hostId, (current) => [
      conversation,
      ...current.filter((item) => item.messages.length > 0),
    ]);
    setActiveConversationIds((current) => ({
      ...current,
      [sessionId]: conversation.id,
    }));
    return conversation;
  }, [hostId, hostName, replaceHostConversations, sessionId]);

  const selectConversation = useCallback(
    (conversationId: string) => {
      if (!sessionId) return;
      const available = hostId
        ? conversationsRef.current[hostId] ?? []
        : [];
      if (!available.some((item) => item.id === conversationId)) return;
      setActiveConversationIds((current) => ({
        ...current,
        [sessionId]: conversationId,
      }));
    },
    [hostId, sessionId],
  );

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      if (!hostId) return undefined;
      const updated = updateConversation(hostId, conversationId, (current) => ({
        ...current,
        title,
        updatedAt: new Date().toISOString(),
      }));
      await persistConversation(updated);
      return updated;
    },
    [hostId, persistConversation, updateConversation],
  );

  const removeConversation = useCallback(
    async (conversationId: string) => {
      if (!hostId || !sessionId) return;
      await storage.delete(conversationId);
      let remaining = replaceHostConversations(hostId, (current) =>
        current.filter((item) => item.id !== conversationId),
      );
      if (!remaining.length) {
        remaining = replaceHostConversations(hostId, () => [
          createAiConversation(hostId, hostName),
        ]);
      }
      setActiveConversationIds((current) =>
        current[sessionId] === conversationId
          ? { ...current, [sessionId]: remaining[0]!.id }
          : current,
      );
    },
    [hostId, hostName, replaceHostConversations, sessionId, storage],
  );

  const getHostConversations = useCallback(
    (targetHostId: string) => conversationsRef.current[targetHostId] ?? [],
    [],
  );
  const isHostLoaded = useCallback(
    (targetHostId: string) => loadedHostsRef.current.has(targetHostId),
    [],
  );

  return {
    activeConversation,
    activeConversationId,
    conversationId,
    conversationsByHost,
    createAndActivateConversation,
    draft,
    getHostConversations,
    hostConversations,
    isHostLoaded,
    loading,
    messages: activeConversation?.messages ?? [],
    persistConversation,
    removeConversation,
    renameConversation,
    selectConversation,
    setDraft,
    updateConversation,
    updateMessages,
  };
}
