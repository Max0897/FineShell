import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AiHandoffRequest } from "../ai-handoff";
import {
  aiRemoteFileContextSource,
  mergeAiRemoteFileContexts,
  redactAiContext,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
} from "../ai-utils";
import type { TerminalSession } from "../models";
import { isTerminalSessionOperational } from "../terminal-utils";

type AiBusinessContextMap = Record<string, AiContextSource[]>;
type AiRemoteFileContextMap = Record<string, AiRemoteFileContext[]>;
type TerminalSelectionMap = Record<string, string>;

export type AiHandoffNoticeType = "error" | "warning";

interface UseAiHandoffControllerOptions {
  activeSession: TerminalSession | null;
  businessContexts: AiBusinessContextMap;
  onNotice: (type: AiHandoffNoticeType, content: string) => void;
  openAssistant: (
    sessionId: string,
    prompt: string,
    contextIds: AiContextSourceId[],
  ) => Promise<boolean>;
  remoteFileContexts: AiRemoteFileContextMap;
  setBusinessContexts: Dispatch<SetStateAction<AiBusinessContextMap>>;
  setRemoteFileContexts: Dispatch<SetStateAction<AiRemoteFileContextMap>>;
  setTerminalSelections: Dispatch<SetStateAction<TerminalSelectionMap>>;
  terminalSelections: TerminalSelectionMap;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function aiHandoffTargetError(
  activeSession: TerminalSession | null,
  sessionId: string,
) {
  if (!activeSession) return "请先打开终端会话";
  if (activeSession.id !== sessionId) {
    return "当前会话已切换，请重新选择要分析的内容";
  }
  if (!isTerminalSessionOperational(activeSession.status)) {
    return "当前会话不可用，请恢复连接后重试";
  }
  return null;
}

export default function useAiHandoffController({
  activeSession,
  businessContexts,
  onNotice,
  openAssistant,
  remoteFileContexts,
  setBusinessContexts,
  setRemoteFileContexts,
  setTerminalSelections,
  terminalSelections,
}: UseAiHandoffControllerOptions) {
  const activeSessionRef = useRef(activeSession);
  const businessContextsRef = useRef(businessContexts);
  const handoffRevisionRef = useRef(new Map<string, number>());
  const handoffSequenceRef = useRef(0);
  const remoteFileContextsRef = useRef(remoteFileContexts);
  const terminalSelectionsRef = useRef(terminalSelections);
  activeSessionRef.current = activeSession;
  businessContextsRef.current = businessContexts;
  remoteFileContextsRef.current = remoteFileContexts;
  terminalSelectionsRef.current = terminalSelections;

  const beginHandoff = useCallback((keys: string[]) => {
    const revision = ++handoffSequenceRef.current;
    for (const key of keys) handoffRevisionRef.current.set(key, revision);
    return revision;
  }, []);

  const finishHandoff = useCallback((keys: string[], revision: number) => {
    for (const key of keys) {
      if (handoffRevisionRef.current.get(key) === revision) {
        handoffRevisionRef.current.delete(key);
      }
    }
  }, []);

  const isCurrentHandoff = useCallback(
    (key: string, revision: number) =>
      handoffRevisionRef.current.get(key) === revision,
    [],
  );

  const validateTarget = useCallback(
    (sessionId: string) => {
      const error = aiHandoffTargetError(activeSessionRef.current, sessionId);
      if (error) onNotice("warning", error);
      return !error;
    },
    [onNotice],
  );

  const revealAssistant = useCallback(
    async (
      sessionId: string,
      prompt: string,
      contextIds: AiContextSourceId[],
    ): Promise<boolean> => {
      try {
        const opened = await openAssistant(sessionId, prompt, contextIds);
        if (!opened) {
          onNotice("warning", "当前会话已切换，请重新选择要分析的内容");
        }
        return opened;
      } catch (error) {
        onNotice("error", `无法打开 AI 助手：${errorMessage(error)}`);
        return false;
      }
    },
    [onNotice, openAssistant],
  );

  const handoffContext = useCallback(
    async (sessionId: string, request: AiHandoffRequest) => {
      if (!validateTarget(sessionId)) return false;
      const content = redactAiContext(request.source.content);
      if (!content.trim()) {
        onNotice("warning", "没有可发送给 AI 的上下文内容");
        return false;
      }
      const source = { ...request.source, content };
      const currentSources = businessContextsRef.current[sessionId] ?? [];
      const previousSource = currentSources.find(
        (item) => item.id === source.id,
      );
      const transactionKey = `business:${sessionId}:${source.id}`;
      const revision = beginHandoff([transactionKey]);
      const nextContexts = {
        ...businessContextsRef.current,
        [sessionId]: [
          ...currentSources.filter((item) => item.id !== source.id),
          source,
        ],
      };
      businessContextsRef.current = nextContexts;
      setBusinessContexts(nextContexts);
      const opened = await revealAssistant(sessionId, request.prompt, [
        source.id,
      ]);
      if (!opened && isCurrentHandoff(transactionKey, revision)) {
        const current = businessContextsRef.current[sessionId] ?? [];
        const restored = current.filter((item) => item.id !== source.id);
        if (previousSource) restored.push(previousSource);
        const rolledBackContexts = { ...businessContextsRef.current };
        if (restored.length) {
          rolledBackContexts[sessionId] = restored;
        } else {
          delete rolledBackContexts[sessionId];
        }
        businessContextsRef.current = rolledBackContexts;
        setBusinessContexts(rolledBackContexts);
      }
      finishHandoff([transactionKey], revision);
      return opened;
    },
    [
      beginHandoff,
      finishHandoff,
      isCurrentHandoff,
      onNotice,
      revealAssistant,
      setBusinessContexts,
      validateTarget,
    ],
  );

  const handoffTerminalSelection = useCallback(
    async (sessionId: string, selection: string) => {
      if (!validateTarget(sessionId)) return false;
      const content = redactAiContext(selection);
      if (!content.trim()) {
        onNotice("warning", "请选择需要 AI 分析的终端内容");
        return false;
      }
      const previousSelection = terminalSelectionsRef.current[sessionId];
      const transactionKey = `terminal-selection:${sessionId}`;
      const revision = beginHandoff([transactionKey]);
      const nextSelections = {
        ...terminalSelectionsRef.current,
        [sessionId]: content,
      };
      terminalSelectionsRef.current = nextSelections;
      setTerminalSelections(nextSelections);
      const opened = await revealAssistant(
        sessionId,
        "请解释这段终端输出，并给出排查建议。",
        ["terminal-selection"],
      );
      if (!opened && isCurrentHandoff(transactionKey, revision)) {
        const rolledBackSelections = { ...terminalSelectionsRef.current };
        if (previousSelection === undefined) {
          delete rolledBackSelections[sessionId];
        } else {
          rolledBackSelections[sessionId] = previousSelection;
        }
        terminalSelectionsRef.current = rolledBackSelections;
        setTerminalSelections(rolledBackSelections);
      }
      finishHandoff([transactionKey], revision);
      return opened;
    },
    [
      beginHandoff,
      finishHandoff,
      isCurrentHandoff,
      onNotice,
      revealAssistant,
      setTerminalSelections,
      validateTarget,
    ],
  );

  const handoffRemoteFiles = useCallback(
    async (sessionId: string, files: AiRemoteFileContext[]) => {
      if (!validateTarget(sessionId)) return false;
      if (!files.length) {
        onNotice("warning", "没有可发送给 AI 的远程文件");
        return false;
      }
      const currentFiles = remoteFileContextsRef.current[sessionId] ?? [];
      const previousFiles = new Map(
        currentFiles.map((file) => [file.path, file]),
      );
      const transactionKeys = files.map(
        (file) => `remote-file:${sessionId}:${file.path}`,
      );
      const revision = beginHandoff(transactionKeys);
      let nextFiles: AiRemoteFileContext[];
      try {
        nextFiles = mergeAiRemoteFileContexts(currentFiles, files);
      } catch (error) {
        finishHandoff(transactionKeys, revision);
        onNotice("warning", errorMessage(error));
        return false;
      }
      const nextContexts = {
        ...remoteFileContextsRef.current,
        [sessionId]: nextFiles,
      };
      remoteFileContextsRef.current = nextContexts;
      setRemoteFileContexts(nextContexts);
      const opened = await revealAssistant(
        sessionId,
        "",
        files.map((file) => aiRemoteFileContextSource(file).id),
      );
      if (!opened) {
        const incomingPaths = new Set(
          files
            .filter((_, index) =>
              isCurrentHandoff(transactionKeys[index]!, revision),
            )
            .map((file) => file.path),
        );
        if (incomingPaths.size) {
          const restoredFiles = (
            remoteFileContextsRef.current[sessionId] ?? []
          ).filter((file) => !incomingPaths.has(file.path));
          for (const path of incomingPaths) {
            const previousFile = previousFiles.get(path);
            if (previousFile) restoredFiles.push(previousFile);
          }
          const rolledBackContexts = { ...remoteFileContextsRef.current };
          if (restoredFiles.length) {
            rolledBackContexts[sessionId] = restoredFiles;
          } else {
            delete rolledBackContexts[sessionId];
          }
          remoteFileContextsRef.current = rolledBackContexts;
          setRemoteFileContexts(rolledBackContexts);
        }
      }
      finishHandoff(transactionKeys, revision);
      return opened;
    },
    [
      beginHandoff,
      finishHandoff,
      isCurrentHandoff,
      onNotice,
      revealAssistant,
      setRemoteFileContexts,
      validateTarget,
    ],
  );

  return {
    handoffContext,
    handoffRemoteFiles,
    handoffTerminalSelection,
  };
}
