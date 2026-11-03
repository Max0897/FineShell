import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AiTaskRecoveryCard from "./AiTaskRecoveryCard";

test("renders recovery decisions at the bottom workflow boundary", () => {
  const onDecision = mock(() => undefined);
  render(
    <AiTaskRecoveryCard
      disconnected={false}
      onDecision={onDecision}
      reason="应用重启"
      sessionAvailable
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "继续分析" }));
  fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
  fireEvent.click(screen.getByRole("button", { name: "结束任务" }));
  expect(onDecision).toHaveBeenNthCalledWith(1, "continue_analysis");
  expect(onDecision).toHaveBeenNthCalledWith(2, "retry");
  expect(onDecision).toHaveBeenNthCalledWith(3, "finish");
});

test("asks for confirmation when an interrupted command may still be running", async () => {
  const onDecision = mock(() => undefined);
  render(
    <AiTaskRecoveryCard
      disconnected={false}
      onDecision={onDecision}
      reason="AI 后台命令执行超时"
      remoteCommandMayBeRunning
      sessionAvailable
    />,
  );

  expect(screen.getByText(/可能仍在服务器上运行，超时或取消不会结束远端进程/)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
  expect(onDecision).not.toHaveBeenCalled();

  await waitFor(() =>
    expect(screen.getByText("中断的命令可能仍在服务器上运行。确认已检查过，再继续？")).not.toBeNull(),
  );
  const confirm = screen
    .getAllByRole("button")
    .find((button) => /确\s*定|确认|OK/.test(button.textContent ?? ""));
  expect(confirm).toBeDefined();
  fireEvent.click(confirm as HTMLElement);
  await waitFor(() => expect(onDecision).toHaveBeenCalledWith("retry"));
});
