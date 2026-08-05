import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { HostRecord, TerminalSession } from "../models";
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
  const onToggleAiAssistant = mock(() => undefined);
  return {
    onActiveSessionChange,
    onToggleAiAssistant,
    ...render(
      <SessionTabs
        activeSessionId={activeSessionId}
        aiAssistantVisible={aiAssistantVisible}
        hasActiveSession={activeSessionId !== null}
        homeContent={<div>主机管理内容</div>}
        onActiveSessionChange={onActiveSessionChange}
        onCloseSession={() => undefined}
        onToggleAiAssistant={onToggleAiAssistant}
        renderSession={(session) => <div>终端 {session.host.name}</div>}
        sessionContextMenuItems={() => []}
        sessions={[SESSION]}
      />,
    ),
  };
}

describe("SessionTabs", () => {
  test("keeps the fixed home entry outside the scrollable tabs", () => {
    const { container } = renderTabs(null);
    const fixedHome = container.querySelector(".terminal-home-tab");
    const tabContainer = container.querySelector(".terminal-tabs");

    expect(fixedHome).not.toBeNull();
    expect(fixedHome?.getAttribute("aria-selected")).toBe("true");
    expect(tabContainer?.contains(fixedHome)).toBe(false);
  });

  test("switches between a session and the fixed home entry", () => {
    const onChange = mock(() => undefined);
    const { container } = renderTabs(null, onChange);

    fireEvent.click(screen.getByText("生产服务器"));
    expect(onChange).toHaveBeenCalledWith("session-1");

    fireEvent.click(container.querySelector(".terminal-home-tab")!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test("keeps the AI toggle fixed outside the scrollable tabs", () => {
    const { container, onToggleAiAssistant } = renderTabs(
      "session-1",
      undefined,
      true,
    );
    const button = screen.getByRole("button", { name: "关闭 AI 助手" });

    expect(container.querySelector(".terminal-tabs")?.contains(button)).toBe(
      false,
    );
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
  });

  test("disables the AI toggle on the fixed home page", () => {
    renderTabs(null);
    expect(
      (
        screen.getByRole("button", {
          name: "打开 AI 助手",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
