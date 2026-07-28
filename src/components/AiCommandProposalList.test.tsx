import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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
  const onInsert = mock(() => undefined);
  const onReject = mock(() => undefined);
  return {
    onAnalyze,
    onCopy,
    onCopyAll,
    onInsert,
    onReject,
    ...render(
      <AiCommandProposalList
        canInsertCommand
        hasRecentTerminalOutput
        hostName="生产服务器"
        onAnalyze={onAnalyze}
        onCopy={onCopy}
        onCopyAll={onCopyAll}
        onInsert={onInsert}
        onReject={onReject}
        proposals={proposals}
        records={records}
        sending={false}
        sessionId="session-1"
      />,
    ),
  };
}

describe("AiCommandProposalList", () => {
  test("routes pending command actions through controlled callbacks", () => {
    const view = renderList();

    expect(screen.getByText("命令计划")).not.toBeNull();
    expect(screen.getByText("uname -a")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制命令提案" }));
    fireEvent.click(screen.getByRole("button", { name: "填入终端" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    expect(view.onCopy).toHaveBeenCalledWith("uname -a");
    expect(view.onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: "command-1" }));
    expect(view.onReject).toHaveBeenCalledWith("command-1");
  });

  test("offers result analysis only after a command was submitted", () => {
    const executed = proposal("executed");
    const view = renderList([executed]);

    fireEvent.click(screen.getByRole("button", { name: "分析结果" }));
    expect(view.onAnalyze).toHaveBeenCalledWith(executed);
    expect(screen.getByText("已检测到手动提交，不代表命令执行成功")).not.toBeNull();
  });

  test("renders persisted metadata without exposing a command", () => {
    renderList([], [
      {
        id: "record-1",
        purpose: "重启服务",
        risk: "danger",
        status: "rejected",
      },
    ]);

    expect(screen.getByText("命令提案记录")).not.toBeNull();
    expect(screen.getByText("重启服务")).not.toBeNull();
    expect(screen.getByText("高风险")).not.toBeNull();
    expect(screen.getByText("已拒绝")).not.toBeNull();
    expect(screen.queryByText("uname -a")).toBeNull();
  });
});
