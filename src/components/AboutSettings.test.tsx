import { afterEach, describe, expect, mock, test } from "bun:test";
import { Modal } from "@arco-design/web-react";
import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ApplicationUpdate,
  ApplicationUpdateNotice,
  ApplicationUpdaterService,
} from "../app-updater";
import AboutSettings from "./AboutSettings";

afterEach(async () => {
  await act(async () => {
    Modal.destroyAll();
  });
  document
    .querySelectorAll(".arco-modal-wrapper")
    .forEach((wrapper) => wrapper.parentElement?.remove());
});

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

  test("shows a persisted update and verifies it automatically", async () => {
    const close = mock(async () => undefined);
    const checkForUpdate = mock(async () => ({
      body: "服务端返回的最新说明。",
      close,
      currentVersion: "0.1.0",
      date: "2026-07-25T00:00:00Z",
      downloadAndInstall: async () => undefined,
      version: "0.2.0",
    }));
    const knownUpdate: ApplicationUpdateNotice = {
      body: "本地保存的更新说明。",
      currentVersion: "0.1.0",
      date: "2026-07-25T00:00:00Z",
      version: "0.2.0",
    };

    const view = render(
      <StrictMode>
        <AboutSettings
          knownUpdate={knownUpdate}
          updater={updaterService({ checkForUpdate })}
        />
      </StrictMode>,
    );

    expect(screen.getByText("发现新版本 v0.2.0")).not.toBeNull();
    expect(screen.getByText("本地保存的更新说明。")).not.toBeNull();
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("服务端返回的最新说明。")).not.toBeNull();

    view.unmount();
    expect(close).toHaveBeenCalledTimes(2);
  });

  test("closes an update returned after the page is unmounted", async () => {
    let resolveCheck: ((update: ApplicationUpdate) => void) | undefined;
    const close = mock(async () => undefined);
    const update: ApplicationUpdate = {
      close,
      currentVersion: "0.1.0",
      downloadAndInstall: async () => undefined,
      version: "0.2.0",
    };
    const checkForUpdate = mock(
      () =>
        new Promise<ApplicationUpdate>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const view = render(
      <AboutSettings updater={updaterService({ checkForUpdate })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledTimes(1));
    view.unmount();
    resolveCheck?.(update);

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  test("keeps the update resource alive while installation is running", async () => {
    let finishDownload: (() => void) | undefined;
    const close = mock(async () => undefined);
    const relaunch = mock(async () => undefined);
    const downloadAndInstall = mock(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    const update: ApplicationUpdate = {
      close,
      currentVersion: "0.1.0",
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
    fireEvent.click(
      await screen.findByRole("button", { name: "下载并安装" }),
    );
    expect(
      await screen.findByText(/更新会关闭当前 SSH 会话/),
    ).not.toBeNull();
    const installButtons = screen.getAllByRole("button", {
      name: "下载并安装",
    });
    fireEvent.click(installButtons[installButtons.length - 1]);
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(close).toHaveBeenCalledTimes(0);
    finishDownload?.();

    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
