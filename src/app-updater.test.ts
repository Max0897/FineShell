import { describe, expect, test } from "bun:test";
import {
  checkForApplicationUpdateOnStartup,
  createMockApplicationUpdate,
  formatUpdateBytes,
  listenApplicationUpdateNotice,
  readApplicationUpdateNotice,
  setApplicationUpdateNotice,
} from "./app-updater";

describe("application updater helpers", () => {
  test("formats update download sizes", () => {
    expect(formatUpdateBytes(0)).toBe("0 B");
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(1536)).toBe("1.5 KB");
    expect(formatUpdateBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("creates a safe development update preview", () => {
    const update = createMockApplicationUpdate();

    expect(update.currentVersion).toBe("0.1.0");
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
      date: "2026-07-25T00:00:00Z",
      version: "0.2.0",
    });
    expect(readApplicationUpdateNotice()).toEqual({
      date: "2026-07-25T00:00:00Z",
      version: "0.2.0",
    });
    setApplicationUpdateNotice(null);
    expect(readApplicationUpdateNotice()).toBeNull();
    expect(notices).toEqual(["0.2.0", undefined]);

    unlisten();
  });

  test("skips the startup update request outside production Tauri", async () => {
    expect(await checkForApplicationUpdateOnStartup()).toBeNull();
  });
});
