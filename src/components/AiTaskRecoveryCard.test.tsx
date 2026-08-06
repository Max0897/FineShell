import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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
