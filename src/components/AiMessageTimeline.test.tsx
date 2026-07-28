import { createRef } from "react";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiMessage } from "../hooks/useAiConversations";
import AiMessageTimeline from "./AiMessageTimeline";

function renderTimeline(
  messages: AiMessage[] = [],
  onRetryMessage = mock(() => undefined),
  onSelectPreset = mock(() => undefined),
) {
  return {
    onRetryMessage,
    onSelectPreset,
    ...render(
      <AiMessageTimeline
        activeConversationAvailable
        applyingFileChanges={false}
        canInsertCommand
        expandedToolRuns={new Set()}
        hasRecentTerminalOutput={false}
        hostName="生产服务器"
        loading={false}
        messages={messages}
        onAddToolRunToDraft={() => undefined}
        onAnalyzeCommand={() => undefined}
        onApplyAllFileEdits={() => undefined}
        onApplyAllFileOperations={() => undefined}
        onCopyCode={async () => undefined}
        onCopyCommand={() => undefined}
        onCopyCommands={() => undefined}
        onCopyToolRun={() => undefined}
        onInsertCommand={async () => undefined}
        onInsertCommandProposal={() => undefined}
        onOpenFileEditReview={() => undefined}
        onOpenFileOperationReview={() => undefined}
        onRejectCommand={() => undefined}
        onRejectFileEdit={() => undefined}
        onRejectFileOperation={() => undefined}
        onRerunTool={() => undefined}
        onRetryFileEdit={() => undefined}
        onRetryFileOperation={() => undefined}
        onRetryMessage={onRetryMessage}
        onRollbackAllFileEdits={() => undefined}
        onRollbackAllFileOperations={() => undefined}
        onRollbackFileEdit={() => undefined}
        onRollbackFileOperation={() => undefined}
        onSelectPreset={onSelectPreset}
        onToggleToolRun={() => undefined}
        scrollRef={createRef<HTMLDivElement>()}
        sending={false}
        sessionId="session-1"
      />,
    ),
  };
}

describe("AiMessageTimeline", () => {
  test("renders task presets and delegates the selected preset", () => {
    const view = renderTimeline();

    fireEvent.click(screen.getByRole("button", { name: "解释终端输出" }));

    expect(screen.getByText("常用任务")).not.toBeNull();
    expect(view.onSelectPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: "explain-output" }),
    );
  });

  test("renders message roles and delegates failed response retries", () => {
    const view = renderTimeline([
      {
        content: "检查服务器负载",
        id: "user-1",
        role: "user",
      },
      {
        content: "",
        error: "服务暂时不可用",
        failed: true,
        id: "assistant-1",
        role: "assistant",
      },
    ]);

    expect(screen.getByText("你")).not.toBeNull();
    expect(screen.getByText("AI")).not.toBeNull();
    expect(screen.getByText("检查服务器负载")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(view.onRetryMessage).toHaveBeenCalledWith(1);
  });
});
