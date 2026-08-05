import type { ReactNode } from "react";
import { Button, Tabs, Tooltip } from "@arco-design/web-react";
import { IconHome } from "@arco-design/web-react/icon";
import { Bot } from "lucide-react";
import type { TerminalSession } from "../models";
import { sessionTabName } from "../terminal-utils";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const HOME_TAB_ID = "home";

interface SessionTabsProps {
  activeSessionId: string | null;
  aiAssistantVisible: boolean;
  hasActiveSession: boolean;
  homeContent: ReactNode;
  onActiveSessionChange: (sessionId: string | null) => void;
  onCloseSession: (sessionId: string) => void;
  onToggleAiAssistant: () => void;
  renderSession: (session: TerminalSession) => ReactNode;
  sessionContextMenuItems: (session: TerminalSession) => ContextMenuItem[];
  sessions: TerminalSession[];
}

function sessionStatusLabel(session: TerminalSession) {
  const labels = {
    connecting: "连接中",
    connected: "已连接",
    suspect: "响应异常",
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
  aiAssistantVisible,
  hasActiveSession,
  homeContent,
  onActiveSessionChange,
  onCloseSession,
  onToggleAiAssistant,
  renderSession,
  sessionContextMenuItems,
  sessions,
}: SessionTabsProps) {
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
      <div className="terminal-ai-action">
        <Tooltip content="AI">
          <span>
            <Button
              aria-label={aiAssistantVisible ? "关闭 AI 助手" : "打开 AI 助手"}
              aria-pressed={aiAssistantVisible}
              className={`terminal-ai-action-button${
                aiAssistantVisible ? " is-active" : ""
              }`}
              disabled={!hasActiveSession}
              icon={<Bot aria-hidden="true" />}
              onClick={onToggleAiAssistant}
              type="text"
            />
          </span>
        </Tooltip>
      </div>
    </>
  );
}

export default SessionTabs;
