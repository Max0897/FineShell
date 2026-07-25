import { describe, expect, mock, test } from "bun:test";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ApplicationUpdate,
  ApplicationUpdaterService,
} from "../app-updater";
import AboutSettings from "./AboutSettings";

function updaterService(
  overrides: Partial<ApplicationUpdaterService> = {},
): ApplicationUpdaterService {
  return {
    canInstallUpdates: true,
    checkForUpdate: async () => null,
    getApplicationInfo: async () => ({
      name: "FineShell",
      tauriVersion: "2.11.5",
      version: "0.1.0",
    }),
    relaunch: async () => undefined,
    ...overrides,
  };
}

describe("AboutSettings", () => {
  test("shows installed application information", async () => {
    render(
      <AboutSettings
        updater={updaterService({ canInstallUpdates: false })}
      />,
    );

    expect(await screen.findByText("v0.1.0")).not.toBeNull();
    expect(screen.getByText("2.11.5")).not.toBeNull();
    expect(screen.getByText("Apache-2.0")).not.toBeNull();
    expect(
      (screen.getByRole("button", {
        name: "检查更新",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/开发模式不支持安装更新/)).not.toBeNull();
  });

  test("checks, downloads, installs, and relaunches an update", async () => {
    const relaunch = mock(async () => undefined);
    const close = mock(async () => undefined);
    const downloadAndInstall: ApplicationUpdate["downloadAndInstall"] = mock(
      async (onEvent) => {
        onEvent?.({ event: "Started", data: { contentLength: 1024 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
        onEvent?.({ event: "Finished" });
      },
    );
    const update: ApplicationUpdate = {
      body: "新增应用内更新。",
      close,
      currentVersion: "0.1.0",
      date: "2026-07-25T00:00:00Z",
      downloadAndInstall,
      version: "0.2.0",
    };

    const view = render(
      <AboutSettings
        updater={updaterService({
          checkForUpdate: async () => update,
          relaunch,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("发现新版本 v0.2.0")).not.toBeNull();
    expect(screen.getByText("新增应用内更新。")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    expect(
      await screen.findByText(/更新会关闭当前 SSH 会话/),
    ).not.toBeNull();
    const installButtons = screen.getAllByRole("button", {
      name: "下载并安装",
    });
    fireEvent.click(installButtons[installButtons.length - 1]);

    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/正在重新启动 FineShell/)).not.toBeNull();

    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
