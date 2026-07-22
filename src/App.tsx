import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Descriptions,
  Empty,
  Input,
  Message,
  ResizeBox,
  Space,
  Table,
  Tabs,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IconArrowUp,
  IconFolderAdd,
  IconPoweroff,
  IconRefresh,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import type { HostRecord, TerminalSession } from "./models";
import "./App.css";

interface FileEntry {
  id: string;
  name: string;
  size: string;
  modifiedAt: string;
}

interface BrowserConnectionMessage {
  type: "fineshell:host-connect";
  host: HostRecord;
}

const HOST_MANAGER_STATE_EVENT = "fineshell:host-manager-state";
let hostManagerOpening = false;

function setMainWindowBlocked(blocked: boolean) {
  window.dispatchEvent(
    new CustomEvent<boolean>(HOST_MANAGER_STATE_EVENT, { detail: blocked }),
  );
}

const fileColumns: TableColumnProps<FileEntry>[] = [
  { title: "名称", dataIndex: "name" },
  { title: "大小", dataIndex: "size", width: 120 },
  { title: "修改时间", dataIndex: "modifiedAt", width: 180 },
];

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function targetKey(target: Pick<HostRecord, "address" | "port" | "username">) {
  return `${target.username}@${target.address}:${target.port}`;
}

function formatTime(value?: string) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function isBrowserConnectionMessage(value: unknown): value is BrowserConnectionMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Partial<BrowserConnectionMessage>;
  return (
    message.type === "fineshell:host-connect" &&
    typeof message.host?.id === "string" &&
    typeof message.host.address === "string"
  );
}

async function openHostManager(tab: "hosts" | "history" = "hosts") {
  if (!isTauri()) {
    const popup = window.open(
      `/?view=host-manager&tab=${tab}`,
      "host-manager",
      "popup,width=880,height=640",
    );
    if (!popup) Message.warning("浏览器阻止了主机管理窗口");
    return;
  }

  if (hostManagerOpening) return;
  hostManagerOpening = true;

  const mainWindow = getCurrentWindow();
  const restoreMainWindow = () => {
    setMainWindowBlocked(false);
    void mainWindow.setFocus();
  };

  try {
    const existingWindow = await WebviewWindow.getByLabel("host-manager");
    if (existingWindow) {
      setMainWindowBlocked(true);
      existingWindow.once("tauri://destroyed", restoreMainWindow);
      await emitTo("host-manager", "host-manager:show-tab", tab);
      await existingWindow.setFocus();
      hostManagerOpening = false;
      return;
    }

    setMainWindowBlocked(true);
    const managerWindow = new WebviewWindow("host-manager", {
      url: `/?view=host-manager&tab=${tab}`,
      title: "主机管理",
      width: 880,
      height: 640,
      minWidth: 720,
      minHeight: 520,
      center: true,
      focus: true,
      resizable: true,
      alwaysOnTop: true,
      parent: "main",
    });
    managerWindow.once("tauri://created", () => {
      hostManagerOpening = false;
    });
    managerWindow.once("tauri://destroyed", restoreMainWindow);
    managerWindow.once("tauri://error", () => {
      hostManagerOpening = false;
      restoreMainWindow();
      Message.error("无法打开主机管理窗口");
    });
  } catch {
    hostManagerOpening = false;
    restoreMainWindow();
    Message.error("无法打开主机管理窗口");
  }
}

function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hostManagerActive, setHostManagerActive] = useState(false);

  const openSession = useCallback((host: HostRecord) => {
    setSessions((current) => {
      const identity = targetKey(host);
      const existing = current.find(
        (session) => targetKey(session.host) === identity,
      );
      if (existing) {
        setActiveSessionId(existing.id);
        return current;
      }

      const session: TerminalSession = {
        id: createId("session"),
        host,
        openedAt: new Date().toISOString(),
      };
      setActiveSessionId(session.id);
      return [...current, session];
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<HostRecord>("host-connect", ({ payload }) => {
      openSession(payload);
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openSession]);

  useEffect(() => {
    function handleWindowMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin) return;
      if (isBrowserConnectionMessage(event.data)) {
        openSession(event.data.host);
      }
    }

    window.addEventListener("message", handleWindowMessage);
    return () => window.removeEventListener("message", handleWindowMessage);
  }, [openSession]);

  useEffect(() => {
    function handleHostManagerState(event: Event) {
      setHostManagerActive((event as CustomEvent<boolean>).detail);
    }

    window.addEventListener(HOST_MANAGER_STATE_EVENT, handleHostManagerState);
    return () => {
      window.removeEventListener(
        HOST_MANAGER_STATE_EVENT,
        handleHostManagerState,
      );
    };
  }, []);

  useEffect(() => {
    if (!hostManagerActive) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    function blockMainWindowKeyboard(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
    }

    window.addEventListener("keydown", blockMainWindowKeyboard, true);
    return () => {
      window.removeEventListener("keydown", blockMainWindowKeyboard, true);
    };
  }, [hostManagerActive]);

  useEffect(() => {
    if (isTauri()) void openHostManager();
  }, []);

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeHost = activeSession?.host ?? null;

  function closeSession(sessionId: string) {
    const currentIndex = sessions.findIndex(
      (session) => session.id === sessionId,
    );
    const remaining = sessions.filter((session) => session.id !== sessionId);
    setSessions(remaining);

    if (activeSessionId === sessionId) {
      const nextIndex = Math.max(0, currentIndex - 1);
      setActiveSessionId(remaining[nextIndex]?.id ?? null);
    }
  }

  const serverInfoPanel = (
    <aside className="panel server-info-panel">
      <div className="panel-toolbar">
        <Typography.Text bold>服务器信息</Typography.Text>
        <Tooltip content="主机管理">
          <Button
            aria-label="打开主机管理"
            icon={<IconStorage />}
            onClick={() => void openHostManager()}
            size="small"
          />
        </Tooltip>
      </div>
      {activeHost ? (
        <div className="server-info-content">
          <div className="server-title-row">
            <div>
              <Typography.Title heading={6}>{activeHost.name}</Typography.Title>
              <Typography.Text type="secondary">
                {activeHost.address}
              </Typography.Text>
            </div>
          </div>
          <Descriptions
            column={1}
            data={[
              { label: "协议", value: "SSH" },
              { label: "用户名", value: activeHost.username },
              { label: "端口", value: activeHost.port },
              { label: "分组", value: activeHost.group || "未分组" },
              {
                label: "打开时间",
                value: formatTime(activeSession?.openedAt),
              },
            ]}
            layout="inline-horizontal"
            size="small"
          />
          <div className="server-actions">
            <Button
              icon={<IconPoweroff />}
              onClick={() => activeSession && closeSession(activeSession.id)}
              status="danger"
            >
              关闭会话
            </Button>
          </div>
        </div>
      ) : (
        <div className="panel-empty">
          <div className="empty-action">
            <Empty description="未选择服务器" />
            <Button
              icon={<IconStorage />}
              onClick={() => void openHostManager()}
              type="primary"
            >
              主机管理
            </Button>
          </div>
        </div>
      )}
    </aside>
  );

  const terminalPanel = (
    <section className="panel terminal-panel">
      <Tabs
        activeTab={activeSessionId ?? undefined}
        className={`terminal-tabs${sessions.length === 0 ? " terminal-tabs-empty-state" : ""}`}
        editable
        justify
        onAddTab={() => void openHostManager()}
        onChange={setActiveSessionId}
        onDeleteTab={closeSession}
        showAddButton
        size="small"
        type="card-gutter"
      >
        {sessions.map((session) => (
          <Tabs.TabPane
            closable
            key={session.id}
            title={session.host.name}
          >
            <div className="terminal-screen">
              <div className="terminal-session-meta">
                {session.host.username}@{session.host.address} · SSH
              </div>
              <div className="terminal-prompt" aria-label="终端输入区域">
                <span>$</span>
                <span className="terminal-cursor" />
              </div>
            </div>
          </Tabs.TabPane>
        ))}
      </Tabs>
      {sessions.length === 0 && (
        <div className="panel-empty terminal-empty">
          <Empty description="暂无终端会话" />
        </div>
      )}
    </section>
  );

  const sftpPanel = (
    <section className="panel sftp-panel">
      <div className="panel-toolbar sftp-toolbar">
        <Space size="mini">
          <Typography.Text bold>SFTP</Typography.Text>
          <Tooltip content="返回上级目录">
            <Button
              aria-label="返回上级目录"
              disabled={!activeSession}
              icon={<IconArrowUp />}
              size="mini"
            />
          </Tooltip>
          <Tooltip content="刷新">
            <Button
              aria-label="刷新目录"
              disabled={!activeSession}
              icon={<IconRefresh />}
              size="mini"
            />
          </Tooltip>
        </Space>
        <Input
          className="sftp-path"
          readOnly
          size="small"
          value={activeSession ? "/" : "未连接"}
        />
        <Space size="mini">
          <Button
            disabled={!activeSession}
            icon={<IconFolderAdd />}
            size="mini"
          >
            新建目录
          </Button>
          <Button
            disabled={!activeSession}
            icon={<IconUpload />}
            size="mini"
            type="primary"
          >
            上传
          </Button>
        </Space>
      </div>
      {activeSession ? (
        <Table
          border={false}
          className="sftp-table"
          columns={fileColumns}
          data={[]}
          noDataElement={<Empty description="等待 SFTP 目录数据" />}
          pagination={false}
          rowKey="id"
          size="small"
        />
      ) : (
        <div className="panel-empty">
          <Empty description="SFTP 未连接" />
        </div>
      )}
    </section>
  );

  const rightPanels = (
    <ResizeBox.SplitGroup
      className="right-split"
      direction="vertical"
      panes={[
        { content: terminalPanel, size: 0.68, min: "240px" },
        { content: sftpPanel, min: "180px" },
      ]}
    />
  );

  return (
    <main className="app-shell">
      <div className="app-content">
        <ResizeBox.SplitGroup
          className="main-split"
          direction="horizontal"
          panes={[
            {
              content: serverInfoPanel,
              size: "280px",
              min: "220px",
              max: "400px",
            },
            { content: rightPanels, min: "480px" },
          ]}
        />
      </div>
      {hostManagerActive && (
        <div aria-hidden className="main-input-guard" />
      )}
    </main>
  );
}

export default App;
