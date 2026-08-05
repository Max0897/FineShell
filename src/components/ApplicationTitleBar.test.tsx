import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { primaryShortcutModifier } from "../platform-utils";
import ApplicationTitleBar from "./ApplicationTitleBar";

function renderTitleBar({
  hasActiveSession = true,
  platform = "Win32",
  serverMonitorCollapsed = false,
  sftpCollapsed = false,
} = {}) {
  const onOpenQuickCommands = mock(() => undefined);
  const onOpenSettings = mock(() => undefined);
  const onOpenShortcutGuide = mock(() => undefined);
  const onToggleServerMonitor = mock(() => undefined);
  const onToggleSftp = mock(() => undefined);

  return {
    onOpenQuickCommands,
    onOpenSettings,
    onOpenShortcutGuide,
    onToggleServerMonitor,
    onToggleSftp,
    ...render(
      <ApplicationTitleBar
        hasActiveSession={hasActiveSession}
        onOpenQuickCommands={onOpenQuickCommands}
        onOpenSettings={onOpenSettings}
        onOpenShortcutGuide={onOpenShortcutGuide}
        onToggleServerMonitor={onToggleServerMonitor}
        onToggleSftp={onToggleSftp}
        platform={platform}
        serverMonitorCollapsed={serverMonitorCollapsed}
        sftpCollapsed={sftpCollapsed}
      />,
    ),
  };
}

describe("ApplicationTitleBar", () => {
  test("uses the platform-specific primary shortcut modifier", () => {
    expect(primaryShortcutModifier("MacIntel")).toBe("Command");
    expect(primaryShortcutModifier("Win32")).toBe("Ctrl");
    expect(primaryShortcutModifier("Linux x86_64")).toBe("Ctrl");
  });

  test("keeps one application menu immediately before custom window controls", () => {
    const {
      container,
      onOpenQuickCommands,
      onOpenSettings,
      onOpenShortcutGuide,
    } = renderTitleBar();
    const menuButton = screen.getByRole("button", { name: "打开应用菜单" });

    fireEvent.click(menuButton);
    fireEvent.click(screen.getByText("快捷命令"));
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByText("快捷键"));
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByText("设置"));

    expect(onOpenQuickCommands).toHaveBeenCalledTimes(1);
    expect(onOpenShortcutGuide).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "最小化窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭窗口" })).toBeTruthy();
    expect(
      container.querySelectorAll(".application-titlebar-toolbar button"),
    ).toHaveLength(3);
    expect(
      container
        .querySelector(".application-titlebar-toolbar")
        ?.nextElementSibling?.classList.contains("application-window-controls"),
    ).toBe(true);
  });

  test("uses the native traffic lights on macOS", () => {
    renderTitleBar({ platform: "MacIntel" });

    expect(screen.queryByRole("button", { name: "最小化窗口" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最大化窗口" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭窗口" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开应用菜单" })).toBeTruthy();
  });

  test("disables session actions without an active terminal", () => {
    const { onOpenQuickCommands } = renderTitleBar({
      hasActiveSession: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "打开应用菜单" }));
    const quickCommandItem = screen
      .getByText("快捷命令")
      .closest(".arco-dropdown-menu-item");

    expect(
      quickCommandItem?.classList.contains("arco-dropdown-menu-disabled"),
    ).toBe(true);
    fireEvent.click(quickCommandItem!);
    expect(onOpenQuickCommands).not.toHaveBeenCalled();
  });

  test("keeps panel toggles before the application menu", () => {
    const { container, onToggleServerMonitor, onToggleSftp } = renderTitleBar();
    const monitorButton = screen.getByRole("button", {
      name: "隐藏服务器监控",
    });
    const sftpButton = screen.getByRole("button", { name: "隐藏文件管理" });
    const toolbarButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".application-titlebar-toolbar button",
      ),
    );

    fireEvent.click(monitorButton);
    fireEvent.click(sftpButton);
    expect(onToggleServerMonitor).toHaveBeenCalledTimes(1);
    expect(onToggleSftp).toHaveBeenCalledTimes(1);
    expect(
      toolbarButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["隐藏服务器监控", "隐藏文件管理", "打开应用菜单"]);

    fireEvent.click(screen.getByRole("button", { name: "打开应用菜单" }));
    const items = Array.from(
      document.querySelectorAll(
        ".application-titlebar-menu .arco-dropdown-menu-item",
      ),
    );
    expect(items[items.length - 1]?.textContent).toContain("设置");
  });

  test("shows only the matching open icons while panels are hidden", () => {
    renderTitleBar({ serverMonitorCollapsed: true, sftpCollapsed: true });
    const monitorButton = screen.getByRole("button", {
      name: "显示服务器监控",
    });
    const sftpButton = screen.getByRole("button", { name: "显示文件管理" });

    expect(monitorButton.querySelector(".lucide-panel-left-open")).toBeTruthy();
    expect(monitorButton.querySelector(".lucide-panel-left-close")).toBeNull();
    expect(sftpButton.querySelector(".lucide-panel-bottom-open")).toBeTruthy();
    expect(sftpButton.querySelector(".lucide-panel-bottom-close")).toBeNull();
  });
});
