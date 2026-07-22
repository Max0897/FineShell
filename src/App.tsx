import { useCallback, useEffect, useRef, useState } from "react";
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
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  IconArrowUp,
  IconFolderAdd,
  IconPoweroff,
  IconRefresh,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import type { HostRecord, TerminalSession } from "./models";
import TerminalView from "./components/TerminalView";
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

interface SshConnectResult {
  fingerprint: string;
}

interface SshStatusPayload {
  sessionId: string;
  status: "disconnected";
  error?: string;
}

const HOSTS_STORAGE_KEY = "fineshell.hosts";

function persistHostFingerprint(hostId: string, fingerprint: string) {
  if (hostId.startsWith("quick-")) return;

  try {
    const hosts = JSON.parse(localStorage.getItem(HOSTS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(hosts)) return;
    localStorage.setItem(
      HOSTS_STORAGE_KEY,
      JSON.stringify(
        hosts.map((host) =>
          host?.id === hostId ? { ...host, hostFingerprint: fingerprint } : host,
        ),
      ),
    );
  } catch {
    // A malformed local cache must not interrupt an active SSH connection.
  }
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

let hostManagerOpening = false;

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

  try {
    const existingWindow = await WebviewWindow.getByLabel("host-manager");
    if (existingWindow) {
      await emitTo("host-manager", "host-manager:show-tab", tab);
      await existingWindow.setFocus();
      hostManagerOpening = false;
      return;
    }

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
    });
    managerWindow.once("tauri://created", () => {
      hostManagerOpening = false;
    });
    managerWindow.once("tauri://error", () => {
      hostManagerOpening = false;
      Message.error("无法打开主机管理窗口");
    });
  } catch {
    hostManagerOpening = false;
    Message.error("无法打开主机管理窗口");
  }
}

function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);

  const updateSession = useCallback(
    (sessionId: string, values: Partial<TerminalSession>) => {
      setSessions((current) => {
        const next = current.map((session) =>
          session.id === sessionId ? { ...session, ...values } : session,
        );
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  const connectSession = useCallback(
    async (session: TerminalSession) => {
      try {
        const result = await invoke<SshConnectResult>("ssh_connect", {
          request: {
            sessionId: session.id,
            hostId: session.host.id,
            address: session.host.address,
            port: session.host.port,
            username: session.host.username,
            connectTimeoutSeconds: session.host.connectTimeoutSeconds,
            expectedFingerprint: session.host.hostFingerprint,
            cols: 80,
            rows: 24,
          },
        });
        updateSession(session.id, {
          status: "connected",
          fingerprint: result.fingerprint,
          error: undefined,
          host: {
            ...session.host,
            hostFingerprint: result.fingerprint,
          },
        });
        persistHostFingerprint(session.host.id, result.fingerprint);
      } catch (error) {
        updateSession(session.id, {
          status: "failed",
          error: String(error),
        });
      }
    },
    [updateSession],
  );

  const openSession = useCallback((host: HostRecord) => {
    const identity = targetKey(host);
    const existing = sessionsRef.current.find(
      (session) => targetKey(session.host) === identity,
    );
    if (existing) {
      setActiveSessionId(existing.id);
      return;
    }

    const session: TerminalSession = {
      id: createId("session"),
      host,
      openedAt: new Date().toISOString(),
      status: "connecting",
    };
    const next = [...sessionsRef.current, session];
    sessionsRef.current = next;
    setSessions(next);
    setActiveSessionId(session.id);
    void connectSession(session);
  }, [connectSession]);

  const reconnectSession = useCallback(
    (session: TerminalSession) => {
      updateSession(session.id, { status: "reconnecting", error: undefined });
      void connectSession({
        ...session,
        status: "reconnecting",
        error: undefined,
      });
    },
    [connectSession, updateSession],
  );

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
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SshStatusPayload>("ssh-status", ({ payload }) => {
      updateSession(payload.sessionId, {
        status: payload.status,
        error: payload.error,
      });
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
  }, [updateSession]);

  useEffect(
    () => () => {
      sessionsRef.current.forEach((session) => {
        void invoke("ssh_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
      });
    },
    [],
  );

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
    if (isTauri()) void openHostManager();
  }, []);

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;

  function closeSession(sessionId: string) {
    const currentIndex = sessions.findIndex(
      (session) => session.id === sessionId,
    );
    const remaining = sessions.filter((session) => session.id !== sessionId);
    sessionsRef.current = remaining;
    setSessions(remaining);
    void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);

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
      {activeSession ? (
        <div className="server-info-content">
          <div className="server-title-row">
            <div>
              <Typography.Title heading={6}>
                {activeSession.host.name}
              </Typography.Title>
              <Typography.Text type="secondary">
                {activeSession.host.address}
              </Typography.Text>
            </div>
          </div>
          <Descriptions
            column={1}
            data={[
              { label: "协议", value: "SSH" },
              { label: "状态", value: sessionStatusLabel(activeSession) },
              { label: "用户名", value: activeSession.host.username },
              { label: "端口", value: activeSession.host.port },
              {
                label: "分组",
                value: activeSession.host.group || "未分组",
              },
              {
                label: "打开时间",
                value: formatTime(activeSession?.openedAt),
              },
            ]}
            layout="inline-horizontal"
            size="small"
          />
          <div className="server-actions">
            {(activeSession.status === "failed" ||
              activeSession.status === "disconnected") && (
              <Button
                icon={<IconRefresh />}
                onClick={() => reconnectSession(activeSession)}
              >
                重新连接
              </Button>
            )}
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
            title={
              <Tooltip content={sessionStatusLabel(session)}>
                <span className="terminal-tab-title">
                  <span
                    className={`terminal-status-dot terminal-status-${session.status}`}
                  />
                  <span className="terminal-tab-name">{session.host.name}</span>
                </span>
              </Tooltip>
            }
          >
            <TerminalView
              active={session.id === activeSessionId}
              session={session}
            />
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
    </main>
  );
}

export default App;
