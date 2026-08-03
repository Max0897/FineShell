import { afterEach, describe, expect, mock, test } from "bun:test";
import { UserAttentionType } from "@tauri-apps/api/window";
import packageMetadata from "../package.json";
import {
  checkForApplicationUpdateOnStartup,
  createMockApplicationUpdate,
  formatUpdateBytes,
  listenApplicationUpdateNotice,
  markApplicationUpdateRelaunchFocus,
  readApplicationUpdateNotice,
  restoreApplicationFocusAfterUpdateRelaunch,
  setApplicationUpdateNotice,
} from "./app-updater";

afterEach(() => {
  window.localStorage.removeItem("fineshell:application-update");
  window.localStorage.removeItem("fineshell:application-update-relaunch-focus");
});

describe("application updater helpers", () => {
  test("formats update download sizes", () => {
    expect(formatUpdateBytes(0)).toBe("0 B");
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(1536)).toBe("1.5 KB");
    expect(formatUpdateBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("creates a safe development update preview", () => {
    const update = createMockApplicationUpdate();

    expect(update.currentVersion).toBe(packageMetadata.version);
    expect(update.version).toBe("0.2.0");
    expect(update.body).toContain("### 新增");
    expect(update.body).toContain("| 版本发布 | 自动生成 Release Notes |");
  });

  test("persists and broadcasts the available update notice", () => {
    const notices: (string | undefined)[] = [];
    const unlisten = listenApplicationUpdateNotice((notice) => {
      notices.push(notice?.version);
    });

    setApplicationUpdateNotice({
      body: "### 新增\n\n- 更新说明",
      currentVersion: packageMetadata.version,
      date: "2026-07-25T00:00:00Z",
      version: "0.2.0",
    });
    expect(readApplicationUpdateNotice()).toEqual({
      body: "### 新增\n\n- 更新说明",
      currentVersion: packageMetadata.version,
      date: "2026-07-25T00:00:00Z",
      version: "0.2.0",
    });
    setApplicationUpdateNotice(null);
    expect(readApplicationUpdateNotice()).toBeNull();
    expect(notices).toEqual(["0.2.0", undefined]);

    unlisten();
  });

  test("ignores update notices created for another installed version", () => {
    window.localStorage.setItem(
      "fineshell:application-update",
      JSON.stringify({
        currentVersion: "0.0.9",
        version: "0.1.0",
      }),
    );

    expect(readApplicationUpdateNotice()).toBeNull();
    expect(
      window.localStorage.getItem("fineshell:application-update"),
    ).toBeNull();
  });

  test("skips the startup update request outside production Tauri", async () => {
    expect(await checkForApplicationUpdateOnStartup()).toBeNull();
  });

  test("records a bounded one-shot focus request before relaunch", () => {
    markApplicationUpdateRelaunchFocus("0.2.0", 1234);

    expect(
      JSON.parse(
        window.localStorage.getItem(
          "fineshell:application-update-relaunch-focus",
        ) ?? "null",
      ),
    ).toEqual({ requestedAt: 1234, targetVersion: "0.2.0" });
  });

  test("restores the updated main window after the workspace is ready", async () => {
    const calls: string[] = [];
    let focusChecks = 0;
    window.localStorage.setItem(
      "fineshell:application-update-relaunch-focus",
      JSON.stringify({
        requestedAt: Date.now(),
        targetVersion: packageMetadata.version,
      }),
    );
    const requestUserAttention = mock(
      async (type: UserAttentionType | null) => {
        calls.push(`attention:${type}`);
      },
    );

    const focused = await restoreApplicationFocusAfterUpdateRelaunch(
      {
        async isFocused() {
          calls.push("isFocused");
          focusChecks += 1;
          return focusChecks === 2;
        },
        requestUserAttention,
        async setFocus() {
          calls.push("setFocus");
        },
        async show() {
          calls.push("show");
        },
        async unminimize() {
          calls.push("unminimize");
        },
      },
      async () => undefined,
    );

    expect(focused).toBe(true);
    expect(calls).toEqual([
      "show",
      "unminimize",
      "setFocus",
      "isFocused",
      "setFocus",
      "isFocused",
    ]);
    expect(requestUserAttention).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(
        "fineshell:application-update-relaunch-focus",
      ),
    ).toBeNull();
  });

  test("ignores stale or mismatched relaunch focus requests", async () => {
    window.localStorage.setItem(
      "fineshell:application-update-relaunch-focus",
      JSON.stringify({ requestedAt: 1, targetVersion: "0.0.1" }),
    );
    const show = mock(async () => undefined);

    expect(
      await restoreApplicationFocusAfterUpdateRelaunch({
        isFocused: async () => false,
        requestUserAttention: async () => undefined,
        setFocus: async () => undefined,
        show,
        unminimize: async () => undefined,
      }),
    ).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(
        "fineshell:application-update-relaunch-focus",
      ),
    ).toBeNull();
  });
});
