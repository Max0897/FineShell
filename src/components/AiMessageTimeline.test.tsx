import { createRef } from "react";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiMessage } from "../hooks/useAiConversations";
import AiMessageTimeline from "./AiMessageTimeline";

function renderTimeline(
  messages: AiMessage[] = [],
  onRetryMessage = mock(() => undefined),
  onSelectPreset = mock(() => undefined),
  dockedCommandProposalIds: ReadonlySet<string> = new Set(),
  dockedDiagnosticPlanIds: ReadonlySet<string> = new Set(),
  dockedFileEditProposalIds: ReadonlySet<string> = new Set(),
  dockedFileOperationProposalIds: ReadonlySet<string> = new Set(),
  sending = false,
) {
  return {
    onRetryMessage,
    onSelectPreset,
    ...render(
      <AiMessageTimeline
        activeConversationAvailable
        applyingFileChanges={false}
        canInsertCommand
        dockedCommandProposalIds={dockedCommandProposalIds}
        dockedDiagnosticPlanIds={dockedDiagnosticPlanIds}
        dockedFileEditProposalIds={dockedFileEditProposalIds}
        dockedFileOperationProposalIds={dockedFileOperationProposalIds}
        expandedToolRuns={new Set()}
        hasRecentTerminalOutput={false}
        hostName="生产服务器"
        loading={false}
        messages={messages}
        onAddToolRunToDraft={() => undefined}
        onApproveCommandProposal={() => undefined}
        onAnalyzeCommand={() => undefined}
        onApplyAllFileEdits={() => undefined}
        onApplyAllFileOperations={() => undefined}
        onCopyCode={async () => undefined}
        onCopyCommand={() => undefined}
        onCopyCommands={() => undefined}
        onCopyToolRun={() => undefined}
        onCancelDiagnosticPlan={() => undefined}
        onConfirmDiagnosticPlan={() => undefined}
        onReviseDiagnosticPlan={() => undefined}
        onOpenFileEditReview={() => undefined}
        onOpenFileOperationReview={() => undefined}
        onRejectCommand={() => undefined}
        onReviseCommand={() => undefined}
        onRejectFileEdit={() => undefined}
        onRejectFileOperation={() => undefined}
        onRetryFileEdit={() => undefined}
        onRetryFileOperation={() => undefined}
        onRetryMessage={onRetryMessage}
        onRollbackAllFileEdits={() => undefined}
        onRollbackAllFileOperations={() => undefined}
        onRollbackFileEdit={() => undefined}
        onRollbackFileOperation={() => undefined}
        onSelectPreset={onSelectPreset}
        onStopDiagnosticPlan={() => undefined}
        onToggleToolRun={() => undefined}
        scrollRef={createRef<HTMLDivElement>()}
        sending={sending}
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

  test("keeps unregistered markdown commands copy-only", () => {
    renderTimeline([
      {
        content: "```bash\nsystemctl restart nginx\n```",
        id: "assistant-1",
        role: "assistant",
      },
    ]);

    expect(screen.getByRole("button", { name: "复制代码" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "填入终端" })).toBeNull();
    expect(screen.getByText("仅供查看")).not.toBeNull();
  });

  test("shows completed model reasoning in a collapsed disclosure", () => {
    renderTimeline([
      {
        content: "配置检查完成。",
        id: "assistant-1",
        reasoning: "先读取配置，再对照运行进程。",
        role: "assistant",
      },
    ]);

    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("先读取配置，再对照运行进程。")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("先读取配置，再对照运行进程。")).not.toBeNull();
  });

  test("keeps active model reasoning expanded while waiting for an answer", () => {
    renderTimeline(
      [
        {
          content: "",
          id: "assistant-1",
          reasoning: "正在检查服务器状态。",
          role: "assistant",
        },
      ],
      undefined,
      undefined,
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      true,
    );

    const toggle = screen.getByRole("button", { name: "正在思考..." });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("正在检查服务器状态。")).not.toBeNull();
  });

  test("does not duplicate a command approval docked above the composer", () => {
    renderTimeline(
      [
        {
          commandProposals: [
            {
              assessment: { canInsert: true, label: "低风险", risk: "safe" },
              command: "uname -a",
              id: "command-1",
              purpose: "查看系统信息",
              sessionId: "session-1",
              status: "pending",
            },
          ],
          content: "",
          id: "assistant-1",
          role: "assistant",
        },
      ],
      undefined,
      undefined,
      new Set(["command-1"]),
    );

    expect(screen.queryByText("AI")).toBeNull();
    expect(screen.queryByText("uname -a")).toBeNull();
  });

  test("does not duplicate a diagnostic approval docked above the composer", () => {
    renderTimeline(
      [
        {
          content: "",
          diagnosticPlans: [
            {
              createdAt: "2026-07-30T08:00:00.000Z",
              id: "plan-1",
              status: "pending",
              stepCallIds: ["call-1"],
            },
          ],
          id: "assistant-1",
          role: "assistant",
          toolRuns: [
            {
              callId: "call-1",
              label: "Ping",
              name: "ping_target",
              planId: "plan-1",
              reason: "检查网络",
              startedAt: 1,
              status: "pending",
            },
          ],
        },
      ],
      undefined,
      undefined,
      new Set(),
      new Set(["plan-1"]),
    );

    expect(screen.queryByText("AI")).toBeNull();
    expect(screen.queryByText("Ping")).toBeNull();
  });

  test("does not duplicate a file approval docked above the composer", () => {
    renderTimeline(
      [
        {
          content: "",
          fileEditProposals: [
            {
              content: "next",
              id: "edit-1",
              originalFile: {
                content: "before",
                name: "app.conf",
                path: "/etc/app.conf",
                size: 6,
              },
              sessionId: "session-1",
              status: "pending",
            },
          ],
          id: "assistant-1",
          role: "assistant",
        },
      ],
      undefined,
      undefined,
      new Set(),
      new Set(),
      new Set(["edit-1"]),
    );

    expect(screen.queryByText("AI")).toBeNull();
    expect(screen.queryByText("app.conf")).toBeNull();
  });
});
