import { afterEach, describe, expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import ApplicationErrorBoundary from "./ApplicationErrorBoundary";

function BrokenView(): never {
  throw new Error("测试渲染错误");
}

describe("ApplicationErrorBoundary", () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("shows a recoverable error instead of leaving an empty window", () => {
    console.error = mock(() => undefined);

    const { container } = render(
      <ApplicationErrorBoundary>
        <BrokenView />
      </ApplicationErrorBoundary>,
    );
    const boundary = within(container);

    expect(boundary.getByRole("alert").textContent).toContain("界面加载失败");
    expect(boundary.getByRole("alert").textContent).toContain("测试渲染错误");
    expect(boundary.getByRole("button", { name: "重新加载" })).toBeTruthy();
  });
});
