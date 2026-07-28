import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiPromptPreset } from "../ai-presets";
import type {
  AiContextSource,
  AiRemoteFileContext,
} from "../ai-utils";
import { aiRemoteFileContextSource } from "../ai-utils";
import { useAiDraftActions } from "./useAiDraftActions";

const terminalOutput: AiContextSource = {
  content: "nginx is active",
  id: "terminal-output",
  label: "最近终端输出",
};

const emptyServerMonitor: AiContextSource = {
  content: "",
  id: "server-monitor",
  label: "服务器状态",
};

const remoteFile: AiRemoteFileContext = {
  content: "server { listen 80; }\n",
  name: "nginx.conf",
  path: "/etc/nginx/nginx.conf",
  size: 22,
};

function renderActions(options?: {
  contextSources?: AiContextSource[];
  prompt?: string;
  sessionId?: string | null;
}) {
  const updateDraft = mock(
    (_value: string, _conversationId?: string) => undefined,
  );
  const onNotice = mock((_content: string) => undefined);
  const onRemoveRemoteFile = mock(
    (_sessionId: string, _path: string) => undefined,
  );
  const hook = renderHook(() =>
    useAiDraftActions({
      contextSources: options?.contextSources ?? [terminalOutput],
      conversationId: "conversation-1",
      initialContextIds: [],
      initialPrompt: "",
      initialPromptRequest: 0,
      onNotice,
      onRemoveRemoteFile,
      prompt: options?.prompt ?? "检查配置",
      sending: false,
      sessionId: options?.sessionId === undefined ? "session-1" : options.sessionId,
      updateDraft,
      visible: false,
    }),
  );
  return { ...hook, onNotice, onRemoveRemoteFile, updateDraft };
}

describe("useAiDraftActions", () => {
  test("adds and removes a remote-file mention from the draft", () => {
    const view = renderActions({
      contextSources: [terminalOutput, aiRemoteFileContextSource(remoteFile)],
      prompt: "检查配置",
    });

    act(() => {
      view.result.current.updateRemoteFileMention(remoteFile, true);
    });
    expect(view.updateDraft).toHaveBeenLastCalledWith(
      "检查配置\n\n@文件:/etc/nginx/nginx.conf",
    );

    const selected = renderActions({
      contextSources: [terminalOutput, aiRemoteFileContextSource(remoteFile)],
      prompt: "检查配置\n\n@文件:/etc/nginx/nginx.conf",
    });
    act(() => {
      selected.result.current.removeRemoteFile(remoteFile);
    });
    expect(selected.updateDraft).toHaveBeenLastCalledWith("检查配置");
    expect(selected.onRemoveRemoteFile).toHaveBeenCalledWith(
      "session-1",
      remoteFile.path,
    );
  });

  test("applies only the preset context sources that have content", () => {
    const view = renderActions({
      contextSources: [terminalOutput, emptyServerMonitor],
    });
    const preset: AiPromptPreset = {
      contextIds: ["terminal-output", "server-monitor"],
      id: "diagnose-network",
      label: "排查网络问题",
      prompt: "请排查网络问题",
    };

    act(() => {
      view.result.current.applyPromptPreset(preset);
    });
    expect(view.updateDraft).toHaveBeenCalledWith(
      "请排查网络问题\n\n@最近终端输出",
      "conversation-1",
    );
  });

  test("waits for requested initial context and applies it only once", async () => {
    const updateDraft = mock(
      (_value: string, _conversationId?: string) => undefined,
    );
    const { rerender } = renderHook(
      ({ sources }: { sources: AiContextSource[] }) =>
        useAiDraftActions({
          contextSources: sources,
          conversationId: "conversation-1",
          initialContextIds: ["terminal-output"],
          initialPrompt: "解释输出",
          initialPromptRequest: 3,
          onNotice: () => undefined,
          onRemoveRemoteFile: () => undefined,
          prompt: "",
          sending: false,
          sessionId: "session-1",
          updateDraft,
          visible: true,
        }),
      { initialProps: { sources: [] as AiContextSource[] } },
    );

    expect(updateDraft).not.toHaveBeenCalled();
    rerender({ sources: [terminalOutput] });
    await waitFor(() => expect(updateDraft).toHaveBeenCalledTimes(1));
    expect(updateDraft).toHaveBeenCalledWith(
      "解释输出\n\n@最近终端输出",
      "conversation-1",
    );

    rerender({ sources: [terminalOutput] });
    expect(updateDraft).toHaveBeenCalledTimes(1);
  });
});
