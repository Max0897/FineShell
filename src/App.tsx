import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Message,
  Modal,
  ResizeBox,
  Typography,
} from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import {
  IconClose,
  IconCloseCircle,
  IconPoweroff,
  IconRefresh,
} from "@arco-design/web-react/icon";
import type {
  HostRecord,
  JumpHostConnection,
  PortForwardStatus,
  ProxyRecord,
  QuickCommandRecord,
  TerminalSession,
} from "./models";
import type { ContextMenuItem } from "./components/ContextMenu";
import HostManagerPanel from "./components/HostManagerPanel";
import QuickCommandDrawer from "./components/QuickCommandDrawer";
import ReleaseNotesMarkdown from "./components/ReleaseNotesMarkdown";
import SftpPanel from "./components/SftpPanel";
import TerminalView from "./components/TerminalView";
import SessionTabs from "./components/SessionTabs";
import { withHostDefaults } from "./host-storage";
import { knownHostTargetKey } from "./known-hosts";
import {
  loadConfiguration,
  updateStoredHostFingerprint,
} from "./config-database";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "./app-settings";
import {
  applicationUpdater,
  checkForApplicationUpdateOnStartup,
  setApplicationUpdateNotice,
  type ApplicationUpdate,
} from "./app-updater";
import {
  jumpHostRequest,
  reconnectDelaySeconds,
  sshCredentialId,
} from "./terminal-utils";
import {
  configureDiagnosticLogging,
  diagnosticInvoke as invoke,
  exportDiagnosticLogsWithDialog,
  recordDiagnostic,
} from "./diagnostics";
import {
  commandErrorMessage,
  emitProtocolEventTo,
  FineShellCommandError,
  listenProtocolEvent,
  type SshConnectResult,
  verifyProtocolVersion,
} from "./tauri-protocol";
import { auxiliaryWindowHref } from "./window-view";
import "./App.css";

const ServerMonitorPanel = lazy(
  () => import("./components/ServerMonitorPanel"),
);

let startupUpdatePromptShown = false;

function promptStartupApplicationUpdate(update: ApplicationUpdate) {
  if (startupUpdatePromptShown) return;
  startupUpdatePromptShown = true;

  Modal.confirm({
    autoFocus: false,
    cancelText: "稍后",
    className: "startup-update-modal",
    content: (
      <div className="startup-update-content">
        <Typography.Text>
          当前版本 v{update.currentVersion}，发现新版本 v{update.version}。
        </Typography.Text>
        {update.body && (
          <ReleaseNotesMarkdown className="startup-update-notes">
            {update.body}
          </ReleaseNotesMarkdown>
        )}
      </div>
    ),
    maskClosable: false,
    okText: "立即更新",
    onCancel: () => {
      void update.close();
    },
    onOk: async () => {
      try {
        await update.downloadAndInstall();
        setApplicationUpdateNotice(null);
        await applicationUpdater.relaunch();
      } catch (error) {
        const message = commandErrorMessage(error);
        recordDiagnostic("error", "application.update", "应用更新失败", {
          error: message,
          version: update.version,
        });
        Message.error(`更新失败：${message}`);
        throw error;
      }
    },
    title: "发现新版本",
  });
}

type AuxiliaryWindow = "settings" | "shortcuts";

function openAuxiliaryWindow(view: AuxiliaryWindow) {
  if (!isTauri()) {
    window.open(auxiliaryWindowHref(view), `fineshell-${view}`);
    return;
  }

  const command =
    view === "settings"
      ? "open_settings_window"
      : "open_shortcut_guide_window";
  void invoke(command).catch((error) => {
    const title = view === "settings" ? "设置" : "快捷键说明";
    Message.error(`无法打开${title}：${commandErrorMessage(error)}`);
  });
}

async function exportDiagnosticsFromMainWindow() {
  try {
    const count = await exportDiagnosticLogsWithDialog();
    if (count === null) return;
    Message.success(`已导出 ${count} 条脱敏诊断日志`);
  } catch (error) {
    const message = commandErrorMessage(error);
    recordDiagnostic("error", "diagnostics", "主窗口导出诊断日志失败", {
      error: message,
    });
    Message.error(`导出诊断日志失败：${message}`);
  }
}

async function persistHostFingerprint(host: HostRecord, fingerprint: string) {
  try {
    await updateStoredHostFingerprint(host, fingerprint);
    if (isTauri()) {
      await Promise.all([
        emitProtocolEventTo("main", "configuration:changed").catch(
          () => undefined,
        ),
        emitProtocolEventTo("settings", "configuration:changed").catch(
          () => undefined,
        ),
      ]);
    }
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
          <Alert
            content={
              changed
                ? "服务器返回的指纹与已保存记录不同。确认服务器密钥确实已更换后再继续。"
                : "首次连接该服务器，请先通过可信渠道核对指纹。"
            }
            showIcon
            type={changed ? "error" : "warning"}
          />
          <div className="fingerprint-row">
            <Typography.Text type="secondary">服务器</Typography.Text>
            <Typography.Text className="fingerprint-value">
              {host.address.includes(":")
                ? `[${host.address}]:${host.port}`
                : `${host.address}:${host.port}`}
            </Typography.Text>
          </div>
          {result.expectedFingerprint && (
            <div className="fingerprint-row">
              <Typography.Text type="secondary">原指纹</Typography.Text>
              <Typography.Text className="fingerprint-value">
                {result.expectedFingerprint}
              </Typography.Text>
            </div>
          )}
          <div className="fingerprint-row">
            <Typography.Text type="secondary">
              {changed ? "新指纹" : "SHA256"}
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

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [quickCommands, setQuickCommands] = useState<QuickCommandRecord[]>([]);
  const [quickCommandDrawerVisible, setQuickCommandDrawerVisible] =
    useState(false);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
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
      recordDiagnostic("info", "ssh.session", "开始建立 SSH 会话", {
        authentication: session.host.authMethod,
        reconnectAttempt,
        sessionId: session.id,
      });
      try {
        const result = await invoke<SshConnectResult>("ssh_connect", {
          request: {
            sessionId: session.id,
            hostId: sshCredentialId(session.host),
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
        recordDiagnostic("info", "ssh.session", "SSH 会话连接成功", {
          sessionId: session.id,
        });
      } catch (error) {
        if (intentionallyDisconnectedRef.current.has(session.id)) return;
        if (!sessionsRef.current.some((item) => item.id === session.id)) {
          return;
        }
        const message = commandErrorMessage(error);
        recordDiagnostic("error", "ssh.session", "SSH 会话连接失败", {
          error: message,
          reconnectAttempt,
          sessionId: session.id,
        });
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
    void listenProtocolEvent("ssh-status", ({ payload }) => {
      const session = sessionsRef.current.find(
        (item) => item.id === payload.sessionId,
      );
      if (!session) return;
      if (payload.error) {
        recordDiagnostic(
          payload.recoverable ? "warn" : "error",
          "ssh.session",
          "SSH 会话状态异常",
          {
            error: payload.error,
            recoverable: payload.recoverable,
            sessionId: payload.sessionId,
            status: payload.status,
          },
        );
      }
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

    void listenProtocolEvent(
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
    const protocolReady = isTauri()
      ? verifyProtocolVersion().then(() => undefined)
      : Promise.resolve();
    void protocolReady
      .then(() => loadConfiguration())
      .then((configuration) => {
        if (disposed) return;
        setSettings(configuration.settings);
        setQuickCommands(configuration.quickCommands);
      })
      .catch((error) => {
        if (!disposed) {
          const message = commandErrorMessage(error);
          recordDiagnostic("warn", "configuration", "应用设置读取失败", {
            error: message,
          });
          if (
            error instanceof FineShellCommandError &&
            error.operation === "protocol_version"
          ) {
            Message.error(message);
          } else {
            Message.warning("设置读取失败，已使用默认值");
          }
        }
      })
      .finally(() => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!disposed) {
              window.dispatchEvent(new Event("fineshell:workspace-ready"));
            }
          });
        });
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!applicationUpdater.canInstallUpdates) return;
    void checkForApplicationUpdateOnStartup()
      .then((update) => {
        setApplicationUpdateNotice(update);
        if (update) promptStartupApplicationUpdate(update);
      })
      .catch((error) => {
        recordDiagnostic("warn", "application.update", "启动更新检查失败", {
          error: commandErrorMessage(error),
        });
      });
  }, []);

  useEffect(() => {
    void configureDiagnosticLogging(settings.diagnosticLogLevel).catch(
      (error) => {
        recordDiagnostic("warn", "diagnostics", "日志级别同步失败", {
          error: commandErrorMessage(error),
        });
      },
    );
  }, [settings.diagnosticLogLevel]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void loadConfiguration()
        .then((configuration) => {
          if (disposed) return;
          setQuickCommands(configuration.quickCommands);
          setSessions((current) => {
            const next = current.map((session) => {
              const targetKey = knownHostTargetKey(
                session.host.address,
                session.host.port,
              );
              const knownHost = configuration.knownHosts.find(
                (record) =>
                  knownHostTargetKey(record.address, record.port) === targetKey,
              );
              return {
                ...session,
                host: {
                  ...session.host,
                  hostFingerprint: knownHost?.fingerprint,
                },
              };
            });
            sessionsRef.current = next;
            return next;
          });
        })
        .catch((error) => {
          if (!disposed) {
            recordDiagnostic("warn", "configuration", "配置刷新失败", {
              error: commandErrorMessage(error),
            });
            Message.warning("快捷命令读取失败");
          }
        });
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("settings:changed", ({ payload }) => {
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

  useEffect(() => {
    if (!activeSessionId) {
      setQuickCommandDrawerVisible(false);
      return;
    }
    const handleQuickCommandShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setQuickCommandDrawerVisible(true);
      }
    };
    window.addEventListener("keydown", handleQuickCommandShortcut, true);
    return () =>
      window.removeEventListener("keydown", handleQuickCommandShortcut, true);
  }, [activeSessionId]);

  async function sendQuickCommand(command: string, execute: boolean) {
    if (!activeSession || activeSession.status !== "connected") {
      throw new Error("当前终端未连接");
    }
    const input = execute ? `${command}\r` : command;
    await invoke("ssh_write", {
      sessionId: activeSession.id,
      data: Array.from(new TextEncoder().encode(input)),
    });
    setQuickCommandDrawerVisible(false);
    Message.success(execute ? "命令已发送" : "命令已填入终端");
  }

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
      void invoke("sftp_close_external_edits", { sessionId }).catch(
        () => undefined,
      );
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
      <SessionTabs
        activeSessionId={activeSessionId}
        homeContent={
          <HostManagerPanel onConnect={openSession} settings={settings} />
        }
        onActiveSessionChange={setActiveSessionId}
        onCloseSession={closeSession}
        onExportDiagnostics={() => void exportDiagnosticsFromMainWindow()}
        onOpenQuickCommands={() => setQuickCommandDrawerVisible(true)}
        onOpenSettings={() => openAuxiliaryWindow("settings")}
        onOpenShortcutGuide={() => openAuxiliaryWindow("shortcuts")}
        renderSession={(session) => (
          <TerminalView
            active={session.id === activeSessionId}
            focusRequest={
              session.id === activeSessionId ? terminalFocusRequest : 0
            }
            settings={settings}
            session={session}
          />
        )}
        sessionContextMenuItems={sessionContextMenuItems}
        sessions={sessions}
      />
      <QuickCommandDrawer
        canSend={activeSession?.status === "connected"}
        commands={quickCommands}
        onAfterClose={() =>
          setTerminalFocusRequest((current) => current + 1)
        }
        onCancel={() => setQuickCommandDrawerVisible(false)}
        onSend={sendQuickCommand}
        visible={quickCommandDrawerVisible}
      />
    </section>
  );

  const sftpPanel = (
    <SftpPanel
      confirmFileDelete={settings.confirmFileDelete}
      externalEditorName={settings.externalEditorName}
      externalEditorPath={settings.externalEditorPath}
      session={activeSession}
      showHiddenFiles={settings.showHiddenFiles}
    />
  );

  const rightPanels = (
    <ResizeBox.SplitGroup
      className="right-split"
      direction="vertical"
      panes={[
        { content: terminalPanel, size: 0.64, min: "240px" },
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
            size: "220px",
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
