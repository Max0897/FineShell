import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Empty,
  Message,
  Modal,
  ResizeBox,
  Tabs,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  IconRefresh,
  IconStorage,
} from "@arco-design/web-react/icon";
import type { HostRecord, TerminalSession } from "./models";
import SftpPanel from "./components/SftpPanel";
import TerminalView from "./components/TerminalView";
import { withHostDefaults } from "./host-storage";
import { updateStoredHostFingerprint } from "./config-database";
import { reconnectDelaySeconds } from "./terminal-utils";
import "./App.css";

const ServerMonitorPanel = lazy(
  () => import("./components/ServerMonitorPanel"),
);

interface BrowserConnectionMessage {
  type: "fineshell:host-connect";
  host: HostRecord;
}

interface SshConnectResult {
  status: "connected" | "hostKeyVerificationRequired";
  fingerprint: string;
  expectedFingerprint: string | null;
}

interface SshStatusPayload {
  sessionId: string;
  status: "disconnected";
  error?: string;
  recoverable: boolean;
}

async function persistHostFingerprint(host: HostRecord, fingerprint: string) {
  try {
    await updateStoredHostFingerprint(host, fingerprint);
  } catch {
    // Configuration persistence must not interrupt an active SSH connection.
  }
}

function confirmHostFingerprint(host: HostRecord, result: SshConnectResult) {
  const changed = Boolean(result.expectedFingerprint);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };

    Modal.confirm({
      cancelText: "取消连接",
      className: "fingerprint-confirm-modal",
      content: (
        <div className="fingerprint-confirm-content">
          <Typography.Text>
            {changed
              ? `服务器 ${host.name} 返回的主机指纹与已保存值不同。`
              : `首次连接 ${host.name}，请核对服务器主机指纹。`}
          </Typography.Text>
          {result.expectedFingerprint && (
            <div className="fingerprint-row">
              <Typography.Text type="secondary">已保存</Typography.Text>
              <Typography.Text className="fingerprint-value">
                {result.expectedFingerprint}
              </Typography.Text>
            </div>
          )}
          <div className="fingerprint-row">
            <Typography.Text type="secondary">
              {changed ? "服务器返回" : "SHA256"}
            </Typography.Text>
            <Typography.Text className="fingerprint-value">
              {result.fingerprint}
            </Typography.Text>
          </div>
        </div>
      ),
      maskClosable: false,
      okButtonProps: changed ? { status: "danger" } : undefined,
      okText: changed ? "接受新指纹" : "信任并连接",
      onCancel: () => settle(false),
      onOk: () => settle(true),
      title: changed ? "主机指纹已变更" : "确认主机指纹",
    });
  });
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

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function targetKey(target: Pick<HostRecord, "address" | "port" | "username">) {
  return `${target.username}@${target.address}:${target.port}`;
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
  const reconnectTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

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

  const clearReconnectTimer = useCallback((sessionId: string) => {
    const timer = reconnectTimersRef.current.get(sessionId);
    if (timer) clearTimeout(timer);
    reconnectTimersRef.current.delete(sessionId);
  }, []);

  const connectSession = useCallback(
    async function connect(
      session: TerminalSession,
      reconnectAttempt = 0,
    ) {
      try {
        const result = await invoke<SshConnectResult>("ssh_connect", {
          request: {
            sessionId: session.id,
            hostId: session.host.id,
            address: session.host.address,
            port: session.host.port,
            username: session.host.username,
            authMethod: session.host.authMethod,
            privateKeyPath: session.host.privateKeyPath,
            connectTimeoutSeconds: session.host.connectTimeoutSeconds,
            keepAliveIntervalSeconds:
              session.host.keepAliveIntervalSeconds,
            expectedFingerprint: session.host.hostFingerprint,
            cols: 80,
            rows: 24,
          },
        });
        if (result.status === "hostKeyVerificationRequired") {
          updateSession(session.id, {
            status: "connecting",
            error: "等待确认主机指纹",
          });
          const accepted = await confirmHostFingerprint(session.host, result);
          if (!sessionsRef.current.some((item) => item.id === session.id)) {
            return;
          }
          if (!accepted) {
            updateSession(session.id, {
              status: "failed",
              error: result.expectedFingerprint
                ? "主机指纹已变更，连接已取消"
                : "未信任主机指纹，连接已取消",
            });
            return;
          }

          const trustedHost = {
            ...session.host,
            hostFingerprint: result.fingerprint,
          };
          await persistHostFingerprint(trustedHost, result.fingerprint);
          updateSession(session.id, {
            status: "connecting",
            error: undefined,
            host: trustedHost,
          });
          await connect({ ...session, host: trustedHost }, reconnectAttempt);
          return;
        }
        clearReconnectTimer(session.id);
        updateSession(session.id, {
          status: "connected",
          fingerprint: result.fingerprint,
          error: undefined,
          host: {
            ...session.host,
            hostFingerprint: result.fingerprint,
          },
          reconnectAttempt: 0,
        });
        await persistHostFingerprint(session.host, result.fingerprint);
      } catch (error) {
        if (!sessionsRef.current.some((item) => item.id === session.id)) {
          return;
        }
        const message = String(error);
        if (
          reconnectAttempt > 0 &&
          session.host.autoReconnect &&
          reconnectAttempt < session.host.maxReconnectAttempts
        ) {
          const nextAttempt = reconnectAttempt + 1;
          const delaySeconds = reconnectDelaySeconds(nextAttempt);
          updateSession(session.id, {
            status: "reconnecting",
            error: `第 ${reconnectAttempt} 次重连失败，${delaySeconds} 秒后重试：${message}`,
            reconnectAttempt,
          });
          clearReconnectTimer(session.id);
          const timer = setTimeout(() => {
            reconnectTimersRef.current.delete(session.id);
            const latest = sessionsRef.current.find(
              (item) => item.id === session.id,
            );
            if (latest) void connect(latest, nextAttempt);
          }, delaySeconds * 1000);
          reconnectTimersRef.current.set(session.id, timer);
          return;
        }
        updateSession(session.id, {
          status: "failed",
          error:
            reconnectAttempt > 0
              ? `自动重连失败（已尝试 ${reconnectAttempt} 次）：${message}`
              : message,
          reconnectAttempt,
        });
      }
    },
    [clearReconnectTimer, updateSession],
  );

  const openSession = useCallback((host: HostRecord) => {
    const normalizedHost = withHostDefaults(host);
    const identity = targetKey(normalizedHost);
    const existing = sessionsRef.current.find(
      (session) => targetKey(session.host) === identity,
    );
    if (existing) {
      setActiveSessionId(existing.id);
      return;
    }

    const session: TerminalSession = {
      id: createId("session"),
      host: normalizedHost,
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
      clearReconnectTimer(session.id);
      updateSession(session.id, {
        status: "reconnecting",
        error: undefined,
        reconnectAttempt: 0,
      });
      void connectSession(
        {
          ...session,
          status: "reconnecting",
          error: undefined,
          reconnectAttempt: 0,
        },
        0,
      );
    },
    [clearReconnectTimer, connectSession, updateSession],
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
      const session = sessionsRef.current.find(
        (item) => item.id === payload.sessionId,
      );
      if (!session) return;
      if (payload.recoverable && session.host.autoReconnect) {
        const attempt = 1;
        const delaySeconds = reconnectDelaySeconds(attempt);
        clearReconnectTimer(session.id);
        updateSession(session.id, {
          status: "reconnecting",
          error: `${payload.error || "SSH 连接中断"}，${delaySeconds} 秒后自动重连`,
          reconnectAttempt: attempt,
        });
        const timer = setTimeout(() => {
          reconnectTimersRef.current.delete(session.id);
          const latest = sessionsRef.current.find(
            (item) => item.id === session.id,
          );
          if (latest) void connectSession(latest, attempt);
        }, delaySeconds * 1000);
        reconnectTimersRef.current.set(session.id, timer);
        return;
      }
      updateSession(payload.sessionId, {
        status: payload.status,
        error: payload.error,
        reconnectAttempt: 0,
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
  }, [clearReconnectTimer, connectSession, updateSession]);

  useEffect(
    () => () => {
      reconnectTimersRef.current.forEach((timer) => clearTimeout(timer));
      reconnectTimersRef.current.clear();
      sessionsRef.current.forEach((session) => {
        void invoke("ssh_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
        void invoke("sftp_disconnect", { sessionId: session.id }).catch(
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
    clearReconnectTimer(sessionId);
    const currentIndex = sessions.findIndex(
      (session) => session.id === sessionId,
    );
    const remaining = sessions.filter((session) => session.id !== sessionId);
    sessionsRef.current = remaining;
    setSessions(remaining);
    void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
    void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);

    if (activeSessionId === sessionId) {
      const nextIndex = Math.max(0, currentIndex - 1);
      setActiveSessionId(remaining[nextIndex]?.id ?? null);
    }
  }

  const serverInfoPanel = (
    <aside className="panel server-info-panel">
      <div className="panel-toolbar">
        <Typography.Text bold>服务器监控</Typography.Text>
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
          <Suspense
            fallback={
              <div className="server-monitor-loading">
                <Typography.Text type="secondary">
                  正在加载监控…
                </Typography.Text>
              </div>
            }
          >
            <ServerMonitorPanel session={activeSession} />
          </Suspense>
          {(activeSession.status === "failed" ||
            activeSession.status === "disconnected") && (
            <div className="server-actions">
              <Button
                icon={<IconRefresh />}
                onClick={() => reconnectSession(activeSession)}
              >
                重新连接
              </Button>
            </div>
          )}
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

  const sftpPanel = <SftpPanel session={activeSession} />;

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
