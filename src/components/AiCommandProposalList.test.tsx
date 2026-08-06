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
  sending = false,
  presentation: "approval" | "timeline" = "timeline",
  queueCount = proposals.length,
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
        presentation={presentation}
        proposals={proposals}
        queueCount={queueCount}
        records={records}
        sending={sending}
        sessionId="session-1"
      />,
    ),
  };
}

describe("AiCommandProposalList", () => {
  test("renders the active command as a bottom approval instead of a plan", () => {
    renderList([proposal()], [], true, "approval", 3);

    expect(screen.getByText("需要审批")).not.toBeNull();
    expect(screen.getByText("当前 1 条 · 后续 2 条")).not.toBeNull();
    expect(screen.queryByText("命令计划")).toBeNull();
  });

  test("routes command approval and rejection through controlled callbacks", async () => {
    const view = renderList([proposal()], [], false, "approval");

    expect(screen.getByText("需要审批")).not.toBeNull();
    expect(screen.getByText("uname -a")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制命令提案" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "同意" }));
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
    );
    expect(view.onReject).toHaveBeenCalledWith("command-1");
  });

  test("shows the execution target without an extra details section", () => {
    renderList([proposal()], [], false, "approval");

    expect(screen.getByText("生产服务器 · /root")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "查看详情" })).toBeNull();
  });

  test("keeps a high-risk reason visible without another card", () => {
    renderList(
      [
        {
          ...proposal(),
          assessment: {
            canInsert: true,
            label: "高风险",
            reason: "会删除数据",
            risk: "danger",
          },
        },
      ],
      [],
      false,
      "approval",
    );

    expect(screen.getByText("会删除数据")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "收起详情" })).toBeNull();
  });

  test("collects revision feedback inside the approval card", async () => {
    const view = renderList([proposal()], [], false, "approval");

    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.change(
      screen.getByPlaceholderText(
        "输入其他处理要求，例如：改为只检查状态，不重启服务",
      ),
      { target: { value: "只检查状态，不要重启" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
      await Promise.resolve();
    });

    expect(view.onRevise).toHaveBeenCalledWith(
      expect.objectContaining({ id: "command-1" }),
      "只检查状态，不要重启",
    );
  });

  test("keeps approval controls available while the model turn is paused", () => {
    renderList([proposal()], [], true, "approval");

    expect(
      (screen.getByRole("button", { name: "同意" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("keeps completed commands as passive conversation history", () => {
    const executed = proposal("executed");
    renderList([executed]);

    expect(screen.getByText("终端执行记录")).not.toBeNull();
    expect(screen.queryByText("后台 SSH 已提交，正在等待退出结果")).toBeNull();
    expect(screen.queryByRole("button", { name: "分析结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制命令提案" })).toBeNull();
  });

  test("shows incremental output while a background command is running", () => {
    renderList([
      {
        ...proposal("approved"),
        executionPhase: "running",
        resultOutput: "first line\nsecond line",
      },
    ]);

    expect(screen.getByText("执行中")).not.toBeNull();
    expect(screen.queryByText("后台 SSH 命令正在执行")).toBeNull();
    expect(screen.getByText(/first line\s+second line/)).not.toBeNull();
  });

  test("distinguishes command runtime phases", () => {
    const view = renderList([
      { ...proposal("executed"), executionPhase: "connecting" },
    ]);
    expect(screen.getByText("连接中")).not.toBeNull();
    expect(screen.queryByText("正在建立后台 SSH 执行通道")).toBeNull();

    view.rerender(
      <AiCommandProposalList
        canInsertCommand
        hasRecentTerminalOutput
        hostName="生产服务器"
        onAnalyze={() => undefined}
        onApprove={() => undefined}
        onCopy={() => undefined}
        onCopyAll={() => undefined}
        onReject={() => undefined}
        onRevise={() => undefined}
        proposals={[{ ...proposal("executed"), executionPhase: "cancelling" }]}
        records={[]}
        sending={false}
        sessionId="session-1"
      />,
    );
    expect(screen.getByText("取消中")).not.toBeNull();

    view.rerender(
      <AiCommandProposalList
        canInsertCommand
        hasRecentTerminalOutput
        hostName="生产服务器"
        onAnalyze={() => undefined}
        onApprove={() => undefined}
        onCopy={() => undefined}
        onCopyAll={() => undefined}
        onReject={() => undefined}
        onRevise={() => undefined}
        proposals={[
          { ...proposal("unavailable"), executionPhase: "interrupted" },
        ]}
        records={[]}
        sending={false}
        sessionId="session-1"
      />,
    );
    expect(screen.getByText("已中断")).not.toBeNull();
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
    renderList([failed]);

    expect(screen.getByText("执行失败")).not.toBeNull();
    expect(screen.getByText("退出码 2 · 1.3 秒")).not.toBeNull();
    expect(screen.getByText("permission denied")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "分析结果" })).toBeNull();
  });

  test("keeps completed output visible and allows collapsing it", () => {
    renderList([
      {
        ...proposal("succeeded"),
        durationMs: 250,
        exitCode: 0,
        resultOutput: "nginx.service is active",
      },
    ]);

    expect(screen.getByText("命令输出")).not.toBeNull();
    expect(screen.getByText("nginx.service is active")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起命令输出" }));
    expect(screen.queryByText("nginx.service is active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开命令输出" }));
    expect(screen.getByText("nginx.service is active")).not.toBeNull();
  });

  test("separates output streams and opens the full captured output", () => {
    renderList([
      {
        ...proposal("failed"),
        exitCode: 1,
        fullResultStderr: "full stderr details",
        fullResultStdout: "full stdout details",
        outputStreamsSeparated: true,
        resultStderr: "stderr summary",
        resultStderrTruncated: true,
        resultStdout: "stdout summary",
      },
    ]);

    expect(screen.queryByText("标准输出")).toBeNull();
    expect(screen.getByText("stdout summary")).not.toBeNull();
    expect(screen.queryByText("错误输出")).toBeNull();
    expect(screen.getByText("stderr summary")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看完整输出" }));
    expect(screen.getByText("完整命令输出")).not.toBeNull();
    expect(screen.getByText("full stdout details")).not.toBeNull();
    expect(screen.getByText("full stderr details")).not.toBeNull();
  });

  test("does not render a separate business verification card", () => {
    renderList([
      {
        ...proposal("succeeded"),
        businessVerification: {
          status: "verified",
          summary: "服务 nginx.service 处于运行状态",
        },
        exitCode: 0,
      },
    ]);

    expect(screen.queryByText("验证通过")).toBeNull();
    expect(screen.queryByText("服务 nginx.service 处于运行状态")).toBeNull();
  });
});
