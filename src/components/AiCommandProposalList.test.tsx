import { describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AiCommandProposal,
  AiCommandRecord,
} from "../ai-command-proposals";
import AiCommandProposalList from "./AiCommandProposalList";

function proposal(
  status: AiCommandProposal["status"] = "pending",
): AiCommandProposal {
  return {
    assessment: { canInsert: true, label: "低风险", risk: "safe" },
    command: "uname -a",
    directory: "/root",
    id: "command-1",
    purpose: "查看系统信息",
    sessionId: "session-1",
    status,
  };
}

function renderList(
  proposals: AiCommandProposal[] = [proposal()],
  records: AiCommandRecord[] = [],
) {
  const onAnalyze = mock(() => undefined);
  const onCopy = mock(() => undefined);
  const onCopyAll = mock(() => undefined);
  const onApprove = mock(() => undefined);
  const onReject = mock(() => undefined);
  const onRevise = mock(() => undefined);
  return {
    onApprove,
    onAnalyze,
    onCopy,
    onCopyAll,
    onReject,
    onRevise,
    ...render(
      <AiCommandProposalList
        canInsertCommand
        hasRecentTerminalOutput
        hostName="生产服务器"
        onApprove={onApprove}
        onAnalyze={onAnalyze}
        onCopy={onCopy}
        onCopyAll={onCopyAll}
        onReject={onReject}
        onRevise={onRevise}
        proposals={proposals}
        records={records}
        sending={false}
        sessionId="session-1"
      />,
    ),
  };
}

describe("AiCommandProposalList", () => {
  test("routes command approval and rejection through controlled callbacks", async () => {
    const view = renderList();

    expect(screen.getByText("命令计划")).not.toBeNull();
    expect(screen.getByText("uname -a")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制命令提案" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "允许并运行" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
      await Promise.resolve();
    });

    expect(view.onCopy).toHaveBeenCalledWith("uname -a");
    expect(view.onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "command-1" }),
      "submit",
    );
    expect(view.onReject).toHaveBeenCalledWith("command-1");
  });

  test("collects revision feedback inside the approval card", async () => {
    const view = renderList();

    fireEvent.click(screen.getByRole("button", { name: "提出修改" }));
    fireEvent.change(
      screen.getByPlaceholderText(
        "说明希望调整的内容，例如：改为只检查状态，不重启服务",
      ),
      { target: { value: "只检查状态，不要重启" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送修改要求" }));
      await Promise.resolve();
    });

    expect(view.onRevise).toHaveBeenCalledWith(
      expect.objectContaining({ id: "command-1" }),
      "只检查状态，不要重启",
    );
  });

  test("offers result analysis only after a command was submitted", () => {
    const executed = proposal("executed");
    const view = renderList([executed]);

    fireEvent.click(screen.getByRole("button", { name: "分析结果" }));
    expect(view.onAnalyze).toHaveBeenCalledWith(executed);
    expect(
      screen.getByText("已检测到手动提交，不代表命令执行成功"),
    ).not.toBeNull();
  });

  test("renders persisted metadata without exposing a command", () => {
    renderList(
      [],
      [
        {
          id: "record-1",
          purpose: "重启服务",
          risk: "danger",
          status: "rejected",
        },
      ],
    );

    expect(screen.getByText("命令提案记录")).not.toBeNull();
    expect(screen.getByText("重启服务")).not.toBeNull();
    expect(screen.getByText("高风险")).not.toBeNull();
    expect(screen.getByText("已拒绝")).not.toBeNull();
    expect(screen.queryByText("uname -a")).toBeNull();
  });

  test("shows the exit code and offers captured result analysis", () => {
    const failed = {
      ...proposal("failed"),
      durationMs: 1_250,
      exitCode: 2,
      resultOutput: "permission denied",
    };
    const view = renderList([failed]);

    expect(screen.getByText("执行失败")).not.toBeNull();
    expect(screen.getByText("退出码 2 · 1.3 秒")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分析结果" }));
    expect(view.onAnalyze).toHaveBeenCalledWith(failed);
  });
});
