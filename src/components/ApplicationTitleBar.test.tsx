import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { primaryShortcutModifier } from "../platform-utils";
import ApplicationTitleBar from "./ApplicationTitleBar";

function renderTitleBar({
  aiAssistantVisible = false,
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
  const onToggleAiAssistant = mock(() => undefined);

  return {
    onOpenQuickCommands,
    onOpenSettings,
    onOpenShortcutGuide,
    onToggleServerMonitor,
    onToggleSftp,
    onToggleAiAssistant,
    ...render(
      <ApplicationTitleBar
        aiAssistantVisible={aiAssistantVisible}
        hasActiveSession={hasActiveSession}
        onOpenQuickCommands={onOpenQuickCommands}
        onOpenSettings={onOpenSettings}
        onOpenShortcutGuide={onOpenShortcutGuide}
        onToggleServerMonitor={onToggleServerMonitor}
        onToggleSftp={onToggleSftp}
        onToggleAiAssistant={onToggleAiAssistant}
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

  test("keeps application actions immediately before custom window controls", () => {
    const {
      container,
      onOpenQuickCommands,
      onOpenSettings,
      onOpenShortcutGuide,
      onToggleAiAssistant,
    } = renderTitleBar();

    fireEvent.click(screen.getByRole("button", { name: "打开 AI 助手" }));
    fireEvent.click(screen.getByRole("button", { name: "打开快捷命令" }));
    fireEvent.click(screen.getByRole("button", { name: "打开快捷键与操作" }));
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
    expect(onOpenQuickCommands).toHaveBeenCalledTimes(1);
    expect(onOpenShortcutGuide).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "最小化窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭窗口" })).toBeTruthy();
    expect(
      container.querySelector(".application-titlebar-toolbar")?.nextElementSibling
        ?.classList.contains("application-window-controls"),
    ).toBe(true);
  });

  test("uses the native traffic lights on macOS", () => {
    renderTitleBar({ platform: "MacIntel" });

    expect(screen.queryByRole("button", { name: "最小化窗口" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最大化窗口" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭窗口" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeTruthy();
  });

  test("disables session actions without an active terminal", () => {
    renderTitleBar({ hasActiveSession: false });

    expect(
      (screen.getByRole("button", { name: "打开 AI 助手" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "打开快捷命令" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("exposes the AI action as a close toggle while visible", () => {
    const { onToggleAiAssistant } = renderTitleBar({
      aiAssistantVisible: true,
    });
    const button = screen.getByRole("button", { name: "关闭 AI 助手" });

    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
  });

  test("toggles the monitor and SFTP panels before the settings action", () => {
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

    expect(monitorButton.querySelector(".lucide-panel-left-close")).toBeTruthy();
    expect(sftpButton.querySelector(".lucide-panel-bottom-close")).toBeTruthy();
    expect(
      toolbarButtons[toolbarButtons.length - 3]?.getAttribute("aria-label"),
    ).toBe("隐藏服务器监控");
    expect(
      toolbarButtons[toolbarButtons.length - 2]?.getAttribute("aria-label"),
    ).toBe("隐藏文件管理");
    expect(
      toolbarButtons[toolbarButtons.length - 1]?.getAttribute("aria-label"),
    ).toBe("打开设置");

    fireEvent.click(monitorButton);
    fireEvent.click(sftpButton);
    expect(onToggleServerMonitor).toHaveBeenCalledTimes(1);
    expect(onToggleSftp).toHaveBeenCalledTimes(1);
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
