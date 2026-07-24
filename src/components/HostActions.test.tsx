import { describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostRecord } from "../models";
import HostActions from "./HostActions";

const HOST: HostRecord = {
  id: "host-1",
  name: "生产服务器",
  address: "server.example.com",
  port: 22,
  username: "root",
  authMethod: "password",
  connectTimeoutSeconds: 10,
  keepAliveIntervalSeconds: 15,
  autoReconnect: true,
  maxReconnectAttempts: 3,
};

describe("HostActions", () => {
  test("connects directly and exposes secondary actions from more menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConnect = mock(() => undefined);
    const onEdit = mock(() => undefined);
    const onCopy = mock(() => undefined);

    render(
      <HostActions
        disabled={false}
        host={HOST}
        onConnect={onConnect}
        onCopy={onCopy}
        onDelete={() => undefined}
        onEdit={onEdit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "连接" }));
    expect(onConnect).toHaveBeenCalledWith(HOST);

    await user.click(
      screen.getByRole("button", { name: "更多 生产服务器 操作" }),
    );
    await user.click(await screen.findByText("编辑"));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(HOST));

    await user.click(
      screen.getByRole("button", { name: "更多 生产服务器 操作" }),
    );
    await user.click(await screen.findByText("复制"));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(HOST));
  });

  test("disables both entry points while configuration is changing", () => {
    render(
      <HostActions
        disabled
        host={HOST}
        onConnect={() => undefined}
        onCopy={() => undefined}
        onDelete={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "连接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "更多 生产服务器 操作",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
