import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import ShortcutGuideWindow, { shortcutGuideRows } from "./ShortcutGuideWindow";

describe("ShortcutGuideWindow", () => {
  test("shows every implemented shortcut without category navigation", () => {
    render(<ShortcutGuideWindow />);

    expect(screen.getByText("打开快捷命令")).toBeTruthy();
    expect(screen.getByText("查找终端内容")).toBeTruthy();
    expect(screen.getByText("选中全部文件")).toBeTruthy();
    expect(screen.getByText("反选文件")).toBeTruthy();
    const currentShortcut = shortcutGuideRows()[0].shortcut;
    const otherShortcut = currentShortcut.startsWith("Command")
      ? "Ctrl + Shift + P"
      : "Command + Shift + P";
    expect(screen.getByText(currentShortcut)).toBeTruthy();
    expect(screen.queryByText(otherShortcut)).toBeNull();
  });

  test("returns shortcuts only for the current platform", () => {
    expect(shortcutGuideRows("MacIntel")[0].shortcut).toBe(
      "Command + Shift + P",
    );
    expect(shortcutGuideRows("Win32")[0].shortcut).toBe("Ctrl + Shift + P");
  });
});
