import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Message,
  Modal,
  ResizeBox,
  Tabs,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IconClose,
  IconCloseCircle,
  IconHome,
  IconPoweroff,
  IconRefresh,
} from "@arco-design/web-react/icon";
import type {
  HostRecord,
  JumpHostConnection,
  PortForwardStatus,
  ProxyRecord,
  TerminalSession,
} from "./models";
import ContextMenu, {
  type ContextMenuItem,
} from "./components/ContextMenu";
import HostManagerPanel from "./components/HostManagerPanel";
import SftpPanel from "./components/SftpPanel";
import TerminalView from "./components/TerminalView";
import { withHostDefaults } from "./host-storage";
import {
  loadConfiguration,
  updateStoredHostFingerprint,
} from "./config-database";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "./app-settings";
import { jumpHostRequest, reconnectDelaySeconds } from "./terminal-utils";
import "./App.css";

const ServerMonitorPanel = lazy(
  () => import("./components/ServerMonitorPanel"),
);

interface SshConnectResult {
  status: "connected" | "hostKeyVerificationRequired";
  fingerprint: string;
  expectedFingerprint: string | null;
  portForwards: PortForwardStatus[];
}

interface SshStatusPayload {
  sessionId: string;
  status: "disconnected";
  error?: string;
  recoverable: boolean;
}

interface PortForwardStatusPayload extends PortForwardStatus {
  sessionId: string;
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

const HOME_TAB_ID = "home";

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function targetKey(
  target: Pick<
    HostRecord,
    "address" | "port" | "username" | "proxyId" | "jumpHostId"
  >,
) {
  return `${target.username}@${target.address}:${target.port}#${target.proxyId ?? "direct"}#${target.jumpHostId ?? "no-jump"}`;
}

function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const reconnectTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const manualReconnectsRef = useRef(new Set<string>());
  const intentionallyDisconnectedRef = useRef(new Set<string>());

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

  const updatePortForwardStatus = useCallback(
    (sessionId: string, status: PortForwardStatus) => {
      setSessions((current) => {
        const next = current.map((session) => {
          if (session.id !== sessionId) return session;
          const statuses = session.portForwardStatuses ?? [];
          const exists = statuses.some(
            (item) =>
              item.ruleId === status.ruleId && item.kind === status.kind,
          );
          return {
            ...session,
            portForwardStatuses: exists
              ? statuses.map((item) =>
                  item.ruleId === status.ruleId && item.kind === status.kind
                    ? status
                    : item,
                )
              : [...statuses, status],
          };
        });
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
    async function connect(session: TerminalSession, reconnectAttempt = 0) {
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
            keepAliveIntervalSeconds: session.host.keepAliveIntervalSeconds,
            expectedFingerprint: session.host.hostFingerprint,
            proxy: session.proxy,
            jumpHost: jumpHostRequest(session.jumpHost),
            localPortForwards: session.host.localPortForwards ?? [],
            remotePortForwards: session.host.remotePortForwards ?? [],
            dynamicPortForwards: session.host.dynamicPortForwards ?? [],
            cols: 80,
            rows: 24,
          },
        });
        if (intentionallyDisconnectedRef.current.has(session.id)) {
          void invoke("ssh_disconnect", { sessionId: session.id }).catch(
            () => undefined,
          );
          return;
        }
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
          portForwardStatuses: result.portForwards,
        });
        await persistHostFingerprint(session.host, result.fingerprint);
      } catch (error) {
        if (intentionallyDisconnectedRef.current.has(session.id)) return;
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

  const openSession = useCallback(
    (
      host: HostRecord,
      proxy?: ProxyRecord,
      jumpHost?: JumpHostConnection,
    ) => {
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
        proxy,
        jumpHost,
        openedAt: new Date().toISOString(),
        status: "connecting",
      };
      const next = [...sessionsRef.current, session];
      sessionsRef.current = next;
      setSessions(next);
      setActiveSessionId(session.id);
      void connectSession(session);
    },
    [connectSession],
  );

  const reconnectSession = useCallback(
    (requestedSession: TerminalSession) => {
      const session =
        sessionsRef.current.find((item) => item.id === requestedSession.id) ??
        requestedSession;
      if (
        session.status === "connecting" ||
        session.status === "reconnecting"
      ) {
        return;
      }

      clearReconnectTimer(session.id);
      intentionallyDisconnectedRef.current.delete(session.id);
      updateSession(session.id, {
        status: "reconnecting",
        error: undefined,
        reconnectAttempt: 0,
      });

      if (session.status === "connected") {
        manualReconnectsRef.current.add(session.id);
        void invoke("ssh_disconnect", { sessionId: session.id }).catch(() => {
          if (!manualReconnectsRef.current.delete(session.id)) return;
          const latest = sessionsRef.current.find(
            (item) => item.id === session.id,
          );
          if (latest) void connectSession(latest, 0);
        });
        void invoke("sftp_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
        return;
      }

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
    let unlistenStatus: (() => void) | undefined;
    let unlistenPortForward: (() => void) | undefined;
    void listen<SshStatusPayload>("ssh-status", ({ payload }) => {
      const session = sessionsRef.current.find(
        (item) => item.id === payload.sessionId,
      );
      if (!session) return;
      if (manualReconnectsRef.current.delete(session.id)) {
        const reconnectingSession = {
          ...session,
          status: "reconnecting" as const,
          error: undefined,
          reconnectAttempt: 0,
        };
        updateSession(session.id, reconnectingSession);
        void connectSession(reconnectingSession, 0);
        return;
      }
      if (intentionallyDisconnectedRef.current.has(session.id)) {
        updateSession(session.id, {
          status: "disconnected",
          error: undefined,
          reconnectAttempt: 0,
          portForwardStatuses: (session.portForwardStatuses ?? []).map(
            (status) => ({
              ...status,
              status: "stopped" as const,
              error: undefined,
            }),
          ),
        });
        return;
      }
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
        portForwardStatuses: (session.portForwardStatuses ?? []).map(
          (status) => ({
            ...status,
            status: "stopped" as const,
            error: undefined,
          }),
        ),
      });
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlistenStatus = stopListening;
      }
    });

    void listen<PortForwardStatusPayload>(
      "port-forward-status",
      ({ payload }) => {
        const { sessionId, ...status } = payload;
        updatePortForwardStatus(sessionId, status);
      },
    ).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlistenPortForward = stopListening;
      }
    });

    return () => {
      disposed = true;
      unlistenStatus?.();
      unlistenPortForward?.();
    };
  }, [
    clearReconnectTimer,
    connectSession,
    updatePortForwardStatus,
    updateSession,
  ]);

  useEffect(
    () => () => {
      reconnectTimersRef.current.forEach((timer) => clearTimeout(timer));
      reconnectTimersRef.current.clear();
      manualReconnectsRef.current.clear();
      intentionallyDisconnectedRef.current.clear();
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
    let disposed = false;
    void loadConfiguration()
      .then((configuration) => {
        if (!disposed) setSettings(configuration.settings);
      })
      .catch(() => {
        if (!disposed) Message.warning("设置读取失败，已使用默认值");
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AppSettings>("settings:changed", ({ payload }) => {
      setSettings(sanitizeAppSettings(payload));
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
  }, []);

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;

  function disconnectSession(sessionId: string) {
    clearReconnectTimer(sessionId);
    manualReconnectsRef.current.delete(sessionId);
    intentionallyDisconnectedRef.current.add(sessionId);
    updateSession(sessionId, {
      status: "disconnected",
      error: undefined,
      reconnectAttempt: 0,
      portForwardStatuses: (
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.portForwardStatuses ?? []
      ).map((status) => ({
        ...status,
        status: "stopped" as const,
        error: undefined,
      })),
    });
    void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
    void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);
  }

  function closeSessions(sessionIds: string[]) {
    const closingIds = new Set(sessionIds);
    if (closingIds.size === 0) return;

    const current = sessionsRef.current;
    closingIds.forEach((sessionId) => {
      clearReconnectTimer(sessionId);
      manualReconnectsRef.current.delete(sessionId);
      intentionallyDisconnectedRef.current.delete(sessionId);
      void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
      void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);
    });
    const remaining = current.filter(
      (session) => !closingIds.has(session.id),
    );
    sessionsRef.current = remaining;
    setSessions(remaining);

    setActiveSessionId((currentActiveId) => {
      if (!currentActiveId || !closingIds.has(currentActiveId)) {
        return currentActiveId;
      }
      const currentIndex = current.findIndex(
        (session) => session.id === currentActiveId,
      );
      const nextIndex = Math.max(0, currentIndex - 1);
      return (
        remaining[nextIndex]?.id ?? remaining[remaining.length - 1]?.id ?? null
      );
    });
  }

  function closeSession(sessionId: string) {
    closeSessions([sessionId]);
  }

  function sessionContextMenuItems(
    session: TerminalSession,
  ): ContextMenuItem[] {
    const canDisconnect =
      session.status === "connecting" ||
      session.status === "connected" ||
      session.status === "reconnecting";
    const canReconnect =
      session.status !== "connecting" && session.status !== "reconnecting";

    return [
      {
        key: "disconnect",
        label: "断开连接",
        icon: <IconPoweroff />,
        disabled: !canDisconnect,
        onClick: () => disconnectSession(session.id),
      },
      {
        key: "reconnect",
        label: "重新连接",
        icon: <IconRefresh />,
        disabled: !canReconnect,
        onClick: () => reconnectSession(session),
      },
      {
        key: "close",
        label: "关闭标签",
        icon: <IconClose />,
        dividerBefore: true,
        onClick: () => closeSession(session.id),
      },
      {
        key: "close-others",
        label: "关闭其他标签",
        icon: <IconCloseCircle />,
        disabled: sessions.length <= 1,
        onClick: () =>
          closeSessions(
            sessions
              .filter((item) => item.id !== session.id)
              .map((item) => item.id),
          ),
      },
      {
        key: "close-all",
        label: "关闭全部标签",
        icon: <IconCloseCircle />,
        onClick: () => closeSessions(sessions.map((item) => item.id)),
      },
    ];
  }

  const serverMonitorPanel = (
    <aside className="panel server-monitor-sidebar">
      <div className="server-monitor-content">
        <Suspense
          fallback={
            <div className="server-monitor-loading">
              <Typography.Text type="secondary">正在加载监控…</Typography.Text>
            </div>
          }
        >
          <ServerMonitorPanel
            onPortForwardStatusChange={(status) =>
              activeSession && updatePortForwardStatus(activeSession.id, status)
            }
            refreshIntervalSeconds={settings.monitorRefreshIntervalSeconds}
            session={activeSession}
          />
        </Suspense>
      </div>
    </aside>
  );

  const terminalPanel = (
    <section className="panel terminal-panel">
      <Tabs
        activeTab={activeSessionId ?? HOME_TAB_ID}
        className="terminal-tabs"
        editable
        onAddTab={() => setActiveSessionId(null)}
        onChange={(tabId) =>
          setActiveSessionId(tabId === HOME_TAB_ID ? null : tabId)
        }
        onDeleteTab={closeSession}
        showAddButton
        size="small"
        type="card-gutter"
      >
        <Tabs.TabPane
          closable={false}
          key={HOME_TAB_ID}
          title={
            <span className="terminal-tab-title">
              <IconHome />
              <span className="terminal-tab-name">首页</span>
            </span>
          }
        >
          <HostManagerPanel onConnect={openSession} settings={settings} />
        </Tabs.TabPane>
        {sessions.map((session) => (
          <Tabs.TabPane
            closable
            key={session.id}
            title={
              <ContextMenu items={sessionContextMenuItems(session)}>
                <span
                  className="terminal-tab-context-target"
                  onContextMenu={() => setActiveSessionId(session.id)}
                >
                  <Tooltip content={sessionStatusLabel(session)}>
                    <span className="terminal-tab-title">
                      <span
                        className={`terminal-status-dot terminal-status-${session.status}`}
                      />
                      <span className="terminal-tab-name">
                        {session.host.name}
                      </span>
                    </span>
                  </Tooltip>
                </span>
              </ContextMenu>
            }
          >
            <TerminalView
              active={session.id === activeSessionId}
              settings={settings}
              session={session}
            />
          </Tabs.TabPane>
        ))}
      </Tabs>
    </section>
  );

  const sftpPanel = (
    <SftpPanel
      confirmFileDelete={settings.confirmFileDelete}
      session={activeSession}
      showHiddenFiles={settings.showHiddenFiles}
    />
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
            content: serverMonitorPanel,
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
