import type { ReactNode } from "react";
import { Button, Tabs, Tooltip } from "@arco-design/web-react";
import { IconCommand, IconHome } from "@arco-design/web-react/icon";
import type { TerminalSession } from "../models";
import { sessionTabName } from "../terminal-utils";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const HOME_TAB_ID = "home";

export function primaryShortcutModifier(platform = navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Command" : "Ctrl";
}

interface SessionTabsProps {
  activeSessionId: string | null;
  homeContent: ReactNode;
  onActiveSessionChange: (sessionId: string | null) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenQuickCommands: () => void;
  renderSession: (session: TerminalSession) => ReactNode;
  sessionContextMenuItems: (session: TerminalSession) => ContextMenuItem[];
  sessions: TerminalSession[];
}

function sessionStatusLabel(session: TerminalSession) {
  const labels = {
    connecting: "连接中",
    connected: "已连接",
    failed: "连接失败",
    disconnected: "已断开",
    reconnecting: "重连中",
  };
  return session.error
    ? `${labels[session.status]}：${session.error}`
    : labels[session.status];
}

function SessionTabs({
  activeSessionId,
  homeContent,
  onActiveSessionChange,
  onCloseSession,
  onOpenQuickCommands,
  renderSession,
  sessionContextMenuItems,
  sessions,
}: SessionTabsProps) {
  const activeSession = sessions.find((item) => item.id === activeSessionId);
  const quickCommandShortcut = `${primaryShortcutModifier()} + Shift + P`;

  return (
    <>
      <button
        aria-selected={activeSessionId === null}
        className={`terminal-home-tab${
          activeSessionId === null ? " terminal-home-tab-active" : ""
        }`}
        onClick={() => onActiveSessionChange(null)}
        role="tab"
        type="button"
      >
        <IconHome />
        <span>首页</span>
      </button>
      <Tabs
        activeTab={activeSessionId ?? HOME_TAB_ID}
        className="terminal-tabs"
        editable
        extra={
          <Tooltip
            content={
              activeSession
                ? `快捷命令（${quickCommandShortcut}）`
                : "请先打开终端会话"
            }
          >
            <span className="terminal-command-button-wrapper">
              <Button
                aria-label="打开快捷命令"
                className="terminal-command-button"
                disabled={!activeSession}
                icon={<IconCommand />}
                onClick={onOpenQuickCommands}
                type="text"
              />
            </span>
          </Tooltip>
        }
        onAddTab={() => onActiveSessionChange(null)}
        onChange={(tabId) =>
          onActiveSessionChange(tabId === HOME_TAB_ID ? null : tabId)
        }
        onDeleteTab={onCloseSession}
        showAddButton
        size="small"
        type="card-gutter"
      >
        <Tabs.TabPane
          closable={false}
          key={HOME_TAB_ID}
          title={
            <span className="terminal-tab-label">
              <IconHome />
              <span className="terminal-tab-name">首页</span>
            </span>
          }
        >
          {homeContent}
        </Tabs.TabPane>
        {sessions.map((session) => (
          <Tabs.TabPane
            closable
            key={session.id}
            title={
              <ContextMenu items={sessionContextMenuItems(session)}>
                <span
                  className="terminal-tab-context-target terminal-tab-label"
                  onContextMenu={() => onActiveSessionChange(session.id)}
                >
                  <span
                    className={`terminal-status-dot terminal-status-${session.status}`}
                  />
                  <Tooltip content={sessionStatusLabel(session)}>
                    <span className="terminal-tab-name">
                      {sessionTabName(sessions, session.id)}
                    </span>
                  </Tooltip>
                </span>
              </ContextMenu>
            }
          >
            {renderSession(session)}
          </Tabs.TabPane>
        ))}
      </Tabs>
    </>
  );
}

export default SessionTabs;
