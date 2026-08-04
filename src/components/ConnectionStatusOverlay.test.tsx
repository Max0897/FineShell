import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import ConnectionStatusOverlay from "./ConnectionStatusOverlay";

describe("ConnectionStatusOverlay", () => {
  test("uses a static warning icon and reconnects without a loading icon", () => {
    const onReconnect = mock(() => undefined);
    const { container } = render(
      <ConnectionStatusOverlay
        description="终端连接已断开"
        onReconnect={onReconnect}
      />,
    );

    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(screen.getByText("终端连接已断开")).toBeTruthy();
    expect(
      container.querySelector(".arco-icon-exclamation-circle-fill"),
    ).toBeTruthy();
    expect(container.querySelector(".arco-icon-loading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  test("shows loading feedback and disables repeated reconnects", () => {
    const { container } = render(
      <ConnectionStatusOverlay
        description="正在重新连接服务器"
        onReconnect={() => undefined}
        reconnecting
      />,
    );

    expect(
      (screen.getByRole("button", {
        name: "正在重连",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(container.querySelector(".arco-icon-loading")).toBeTruthy();
    expect(
      container.querySelector(".arco-icon-exclamation-circle-fill"),
    ).toBeNull();
  });
});
