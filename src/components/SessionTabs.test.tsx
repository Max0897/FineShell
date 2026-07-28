import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { HostRecord, TerminalSession } from "../models";
import { primaryShortcutModifier } from "../platform-utils";
import SessionTabs from "./SessionTabs";

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

const SESSION: TerminalSession = {
  id: "session-1",
  host: HOST,
  openedAt: "2026-07-24T00:00:00.000Z",
  status: "connected",
};

function renderTabs(
  activeSessionId: string | null,
  onActiveSessionChange = mock(() => undefined),
  aiAssistantVisible = false,
) {
  const onOpenSettings = mock(() => undefined);
  const onOpenShortcutGuide = mock(() => undefined);
  const onToggleAiAssistant = mock(() => undefined);
  return {
    onActiveSessionChange,
    onToggleAiAssistant,
    onOpenSettings,
    onOpenShortcutGuide,
    ...render(
      <SessionTabs
        activeSessionId={activeSessionId}
        aiAssistantVisible={aiAssistantVisible}
        homeContent={<div>主机管理内容</div>}
        onActiveSessionChange={onActiveSessionChange}
        onCloseSession={() => undefined}
        onOpenQuickCommands={() => undefined}
        onToggleAiAssistant={onToggleAiAssistant}
        onOpenSettings={onOpenSettings}
        onOpenShortcutGuide={onOpenShortcutGuide}
        renderSession={(session) => <div>终端 {session.host.name}</div>}
        sessionContextMenuItems={() => []}
        sessions={[SESSION]}
      />,
    ),
  };
}

describe("SessionTabs", () => {
  test("uses the platform-specific primary shortcut modifier", () => {
    expect(primaryShortcutModifier("MacIntel")).toBe("Command");
    expect(primaryShortcutModifier("Win32")).toBe("Ctrl");
    expect(primaryShortcutModifier("Linux x86_64")).toBe("Ctrl");
  });

  test("keeps the fixed home entry outside the scrollable tabs", () => {
    const {
      container,
      onOpenSettings,
      onOpenShortcutGuide,
    } = renderTabs(null);
    const fixedHome = container.querySelector(".terminal-home-tab");
    const tabContainer = container.querySelector(".terminal-tabs");

    expect(fixedHome).not.toBeNull();
    expect(fixedHome?.getAttribute("aria-selected")).toBe("true");
    expect(tabContainer?.contains(fixedHome)).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "打开快捷命令",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "打开 AI 助手" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "打开快捷键与操作" }));
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenShortcutGuide).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test("switches between a session and the fixed home entry", () => {
    const onChange = mock(() => undefined);
    const { container } = renderTabs(null, onChange);

    fireEvent.click(screen.getByText("生产服务器"));
    expect(onChange).toHaveBeenCalledWith("session-1");

    fireEvent.click(container.querySelector(".terminal-home-tab")!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test("opens the AI sidebar from an active terminal session", () => {
    const { onToggleAiAssistant } = renderTabs("session-1");
    fireEvent.click(screen.getByRole("button", { name: "打开 AI 助手" }));
    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
  });

  test("exposes the same AI button as a close toggle while visible", () => {
    const { onToggleAiAssistant } = renderTabs(
      "session-1",
      mock(() => undefined),
      true,
    );
    const button = screen.getByRole("button", { name: "关闭 AI 助手" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
  });
});
