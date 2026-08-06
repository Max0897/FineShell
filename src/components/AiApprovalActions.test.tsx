import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AiApprovalActions from "./AiApprovalActions";

describe("AiApprovalActions", () => {
  test("locks repeated decisions while the current callback is pending", async () => {
    let resolveApproval: (() => void) | undefined;
    const onApprove = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    render(
      <AiApprovalActions
        approvalKey="approval-1"
        feedbackPlaceholder="输入处理意见"
        onApprove={onApprove}
        onReject={() => undefined}
      />,
    );

    const approve = screen.getByRole("button", { name: "同意" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);

    await act(async () => resolveApproval?.());
  });

  test("clears revision state when the active approval changes", () => {
    const view = render(
      <AiApprovalActions
        approvalKey="approval-1"
        feedbackPlaceholder="输入处理意见"
        onApprove={() => undefined}
        onReject={() => undefined}
        onRevise={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.change(screen.getByPlaceholderText("输入处理意见"), {
      target: { value: "只读取状态" },
    });

    view.rerender(
      <AiApprovalActions
        approvalKey="approval-2"
        feedbackPlaceholder="输入处理意见"
        onApprove={() => undefined}
        onReject={() => undefined}
        onRevise={() => undefined}
      />,
    );

    expect(screen.queryByPlaceholderText("输入处理意见")).toBeNull();
    expect(screen.getByRole("button", { name: "其他" })).not.toBeNull();
  });
});
