import { useEffect, useRef } from "react";
import {
  availablePresetContextIds,
  type AiPromptPreset,
} from "../ai-presets";
import type { AiToolRun } from "../ai-tools";
import {
  aiRemoteFileContextSource,
  appendAiContextMentions,
  stripAiContextMentions,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
} from "../ai-utils";

interface UseAiDraftActionsOptions {
  contextSources: AiContextSource[];
  conversationId?: string;
  initialContextIds: AiContextSourceId[];
  initialPrompt: string;
  initialPromptRequest: number;
  onNotice: (content: string) => void;
  onRemoveRemoteFile: (sessionId: string, path: string) => void;
  prompt: string;
  sending: boolean;
  sessionId: string | null;
  updateDraft: (value: string, conversationId?: string) => void;
  visible: boolean;
}

export function useAiDraftActions({
  contextSources,
  conversationId,
  initialContextIds,
  initialPrompt,
  initialPromptRequest,
  onNotice,
  onRemoveRemoteFile,
  prompt,
  sending,
  sessionId,
  updateDraft,
  visible,
}: UseAiDraftActionsOptions) {
  const appliedInitialPromptRequestRef = useRef(-1);

  const updateRemoteFileMention = (
    file: AiRemoteFileContext,
    checked: boolean,
  ) => {
    const source = aiRemoteFileContextSource(file);
    updateDraft(
      checked
        ? appendAiContextMentions(prompt, contextSources, [source.id])
        : stripAiContextMentions(prompt, [source]),
    );
  };

  const removeRemoteFile = (file: AiRemoteFileContext) => {
    if (!sessionId) return;
    updateDraft(
      stripAiContextMentions(prompt, [aiRemoteFileContextSource(file)]),
    );
    onRemoveRemoteFile(sessionId, file.path);
  };

  const applyPromptPreset = (preset: AiPromptPreset) => {
    if (!conversationId || sending) return;
    updateDraft(
      appendAiContextMentions(
        preset.prompt,
        contextSources,
        availablePresetContextIds(preset, contextSources),
      ),
      conversationId,
    );
  };

  const addToolRunToDraft = (run: AiToolRun) => {
    const value = run.summary ?? run.error;
    if (!value || !conversationId) return;
    const addition = `请结合以下${run.label}结果继续分析：\n${value}`;
    updateDraft([prompt.trim(), addition].filter(Boolean).join("\n\n"));
    onNotice("已加入下一次提问");
  };

  useEffect(() => {
    if (!visible || !conversationId) return;
    if (appliedInitialPromptRequestRef.current === initialPromptRequest) return;
    const availableContextIds = new Set(
      contextSources
        .filter((source) => source.content.trim())
        .map((source) => source.id),
    );
    if (
      initialContextIds.length &&
      !initialContextIds.every((id) => availableContextIds.has(id))
    ) {
      return;
    }
    appliedInitialPromptRequestRef.current = initialPromptRequest;
    const terminalSelection = contextSources.find(
      (source) => source.id === "terminal-selection",
    );
    const contextIds = initialContextIds.length
      ? initialContextIds
      : terminalSelection?.content.trim()
        ? (["terminal-selection"] as AiContextSourceId[])
        : [];
    updateDraft(
      appendAiContextMentions(
        initialPrompt || prompt,
        contextSources,
        contextIds,
      ),
      conversationId,
    );
  }, [
    contextSources,
    conversationId,
    initialContextIds,
    initialPrompt,
    initialPromptRequest,
    prompt,
    updateDraft,
    visible,
  ]);

  return {
    addToolRunToDraft,
    applyPromptPreset,
    removeRemoteFile,
    updateRemoteFileMention,
  };
}
