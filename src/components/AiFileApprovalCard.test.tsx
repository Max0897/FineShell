import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AiFileApprovalCard from "./AiFileApprovalCard";

const proposal = {
  content: "after\nsecond\n",
  id: "edit-1",
  originalFile: {
    content: "before\n",
    name: "app.conf",
    path: "/etc/app.conf",
    size: 7,
  },
  sessionId: "session-1",
  status: "pending" as const,
};

describe("AiFileApprovalCard", () => {
  test("keeps the file action as one bottom approval", async () => {
    const onApprove = mock(() => undefined);
    const onOpenReview = mock(() => undefined);
    const onReject = mock(() => undefined);
    render(
      <AiFileApprovalCard
        applying={false}
        editProposal={proposal}
        onApprove={onApprove}
        onOpenReview={onOpenReview}
        onReject={onReject}
        onRevise={() => undefined}
        queueCount={2}
      />,
    );

    expect(screen.getByText("修改远程文件")).not.toBeNull();
    expect(screen.getByText("/etc/app.conf")).not.toBeNull();
    expect(screen.getByText("待审批 2")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看差异" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "同意" }));
      await Promise.resolve();
    });

    expect(onOpenReview).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  test("returns other instructions instead of requiring list operations", async () => {
    const onRevise = mock(() => undefined);
    render(
      <AiFileApprovalCard
        applying={false}
        editProposal={proposal}
        onApprove={() => undefined}
        onOpenReview={() => undefined}
        onReject={() => undefined}
        onRevise={onRevise}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.change(screen.getByPlaceholderText("说明希望如何调整"), {
      target: { value: "保留文件头注释" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
      await Promise.resolve();
    });

    expect(onRevise).toHaveBeenCalledWith("保留文件头注释");
  });
});
