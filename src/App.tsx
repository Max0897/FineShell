import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
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
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
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
  ServerMonitorSnapshot,
  TerminalSession,
} from "./models";
import type { ContextMenuItem } from "./components/ContextMenu";
import HostManagerPanel from "./components/HostManagerPanel";
import AiAssistantPanel from "./components/AiAssistantPanel";
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
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
  aiRemoteFileContextSource,
  mergeAiRemoteFileContexts,
  formatAiServerContext,
} from "./ai-utils";
import {
  createSftpSelectionAiHandoff,
  type AiHandoffRequest,
} from "./ai-handoff";
import {
  AI_SIDEBAR_DEFAULT_WIDTH,
  aiWindowTargetWidth,
  clampAiSidebarWidth,
} from "./ai-sidebar";
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
  type TerminalCommandSubmission,
  type TerminalInjectedInput,
} from "./terminal-utils";
import {
  configureDiagnosticLogging,
  diagnosticInvoke as invoke,
  recordDiagnostic,
} from "./diagnostics";
import {
  commandErrorMessage,
  emitProtocolEventTo,
  FineShellCommandError,
  listenProtocolEvent,
  type AgentActionExecutionResult,
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
    view === "settings" ? "open_settings_window" : "open_shortcut_guide_window";
  void invoke(command).catch((error) => {
    const title = view === "settings" ? "设置" : "快捷键说明";
    Message.error(`无法打开${title}：${commandErrorMessage(error)}`);
  });
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
  const [aiAssistantVisible, setAiAssistantVisible] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(
    AI_SIDEBAR_DEFAULT_WIDTH,
  );
  const [mainWorkspaceFrozenWidth, setMainWorkspaceFrozenWidth] = useState<
    number | null
  >(null);
  const [aiInitialPrompt, setAiInitialPrompt] = useState("");
  const [aiInitialContextIds, setAiInitialContextIds] = useState<
    AiContextSourceId[]
  >([]);
  const [aiInitialPromptRequest, setAiInitialPromptRequest] = useState(0);
  const [terminalSelections, setTerminalSelections] = useState<
    Record<string, string>
  >({});
  const [terminalRecentOutputs, setTerminalRecentOutputs] = useState<
    Record<string, string>
  >({});
  const [terminalInjectedInputs, setTerminalInjectedInputs] = useState<
    Record<string, TerminalInjectedInput>
  >({});
  const [terminalCommandSubmission, setTerminalCommandSubmission] =
    useState<TerminalCommandSubmission | null>(null);
  const [monitorSnapshots, setMonitorSnapshots] = useState<
    Record<string, ServerMonitorSnapshot>
  >({});
  const [sftpCurrentPaths, setSftpCurrentPaths] = useState<
    Record<string, string>
  >({});
  const [terminalCurrentDirectories, setTerminalCurrentDirectories] = useState<
    Record<string, { path: string; revision: number }>
  >({});
  const [aiRemoteFileContexts, setAiRemoteFileContexts] = useState<
    Record<string, AiRemoteFileContext[]>
  >({});
  const [aiBusinessContexts, setAiBusinessContexts] = useState<
    Record<string, AiContextSource[]>
  >({});
  const [sftpRefreshRequests, setSftpRefreshRequests] = useState<
    Record<string, number>
  >({});
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const aiWindowShouldExpandRef = useRef(false);
  const aiWindowExpandedRef = useRef(false);
  const aiWindowExpansionRef = useRef(0);
  const aiWindowResizeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mainSplitRef = useRef<HTMLElement | null>(null);
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

  const updateMonitorSnapshot = useCallback(
    (sessionId: string | null, snapshot: ServerMonitorSnapshot | null) => {
      if (!sessionId) return;
      setMonitorSnapshots((current) => {
        if (!snapshot) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return { ...current, [sessionId]: snapshot };
      });
    },
    [],
  );

  const updateSftpCurrentPath = useCallback(
    (sessionId: string | null, path: string) => {
      if (!sessionId) return;
      setSftpCurrentPaths((current) => {
        if (!path) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return current[sessionId] === path
          ? current
          : { ...current, [sessionId]: path };
      });
    },
    [],
  );

  const updateTerminalCurrentDirectory = useCallback(
    (sessionId: string, path: string) => {
      setTerminalCurrentDirectories((current) => {
        if (!path) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return {
          ...current,
          [sessionId]: {
            path,
            revision: (current[sessionId]?.revision ?? 0) + 1,
          },
        };
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
    (host: HostRecord, proxy?: ProxyRecord, jumpHost?: JumpHostConnection) => {
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

    void listenProtocolEvent("port-forward-status", ({ payload }) => {
      const { sessionId, ...status } = payload;
      updatePortForwardStatus(sessionId, status);
    }).then((stopListening) => {
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

  useEffect(
    () => () => document.body.classList.remove("ai-sidebar-resizing"),
    [],
  );

  useEffect(() => {
    if (!terminalCommandSubmission) return;
    const submissionId = terminalCommandSubmission.id;
    const timer = window.setTimeout(() => {
      setTerminalCommandSubmission((current) =>
        current?.id === submissionId ? null : current,
      );
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [terminalCommandSubmission]);

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

  const aiContextSources = useMemo<AiContextSource[]>(() => {
    if (!activeSessionId) return [];
    const snapshot = monitorSnapshots[activeSessionId];
    const remoteFiles = aiRemoteFileContexts[activeSessionId] ?? [];
    const sources: AiContextSource[] = [
      {
        id: "terminal-selection",
        label: "终端选区",
        content: terminalSelections[activeSessionId] ?? "",
      },
      {
        id: "terminal-output",
        label: "最近终端输出",
        content: terminalRecentOutputs[activeSessionId] ?? "",
      },
      {
        id: "server-monitor",
        label: "服务器状态",
        content: snapshot ? formatAiServerContext(snapshot) : "",
      },
      {
        id: "sftp-path",
        label: "当前远程目录",
        content: sftpCurrentPaths[activeSessionId] ?? "",
      },
    ];
    sources.push(...(aiBusinessContexts[activeSessionId] ?? []));
    sources.push(...remoteFiles.map(aiRemoteFileContextSource));
    return sources;
  }, [
    activeSessionId,
    aiBusinessContexts,
    aiRemoteFileContexts,
    monitorSnapshots,
    sftpCurrentPaths,
    terminalRecentOutputs,
    terminalSelections,
  ]);

  useEffect(() => {
    if (!activeSessionId) {
      setQuickCommandDrawerVisible(false);
      closeAiAssistant();
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

  function handleAiCommandPrepared(sessionId: string, command: string) {
    if (settings.aiCommandTrackingEnabled) {
      setTerminalInjectedInputs((current) => ({
        ...current,
        [sessionId]: {
          id: createId("terminal-input"),
          value: command,
        },
      }));
    }
    Message.success("命令已填入终端");
  }

  function handleAiAgentActionExecuted(
    sessionId: string,
    result: AgentActionExecutionResult,
  ) {
    if (result.actionType === "terminal_command") return;
    const updatedFile: AiRemoteFileContext | null = result.file
      ? {
          content: result.file.content,
          name: result.file.path.split("/").pop() || result.file.path,
          path: result.file.path,
          size: result.file.size,
        }
      : null;
    setAiRemoteFileContexts((current) => {
      const remaining = (current[sessionId] ?? []).filter(
        (file) => !result.affectedPaths.includes(file.path),
      );
      if (!updatedFile) {
        return { ...current, [sessionId]: remaining };
      }
      let nextFiles = remaining;
      try {
        nextFiles = mergeAiRemoteFileContexts(remaining, [updatedFile]);
      } catch {
        // The remote operation already succeeded; omit the optional AI context
        // when adding it would exceed the local context limits.
      }
      return {
        ...current,
        [sessionId]: nextFiles,
      };
    });
    setSftpRefreshRequests((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? 0) + 1,
    }));
  }

  async function openAiAssistant(
    prompt = "",
    contextIds: AiContextSourceId[] = [],
  ) {
    if (!activeSession) {
      Message.warning("请先打开终端会话");
      return;
    }
    setAiInitialPrompt(prompt);
    setAiInitialContextIds(contextIds);
    setAiInitialPromptRequest((current) => current + 1);
    if (aiWindowShouldExpandRef.current) return;

    aiWindowShouldExpandRef.current = true;
    if (!isTauri()) {
      setAiAssistantVisible(true);
      return;
    }

    const currentMainWidth =
      mainSplitRef.current?.getBoundingClientRect().width;
    if (currentMainWidth) {
      setMainWorkspaceFrozenWidth(currentMainWidth);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    await synchronizeAiWindowWidth();
    if (aiWindowShouldExpandRef.current) {
      setAiAssistantVisible(true);
      setMainWorkspaceFrozenWidth(null);
    }
  }

  async function handoffToAi(sessionId: string, request: AiHandoffRequest) {
    if (sessionId !== activeSessionId) {
      Message.warning("当前会话已切换，请重新选择要分析的内容");
      return;
    }
    setAiBusinessContexts((current) => {
      const sources = current[sessionId] ?? [];
      return {
        ...current,
        [sessionId]: [
          ...sources.filter((source) => source.id !== request.source.id),
          request.source,
        ],
      };
    });
    await openAiAssistant(request.prompt, [request.source.id]);
  }

  async function closeAiAssistant() {
    if (!aiWindowShouldExpandRef.current && !aiAssistantVisible) return;
    aiWindowShouldExpandRef.current = false;
    if (!isTauri()) {
      setAiAssistantVisible(false);
      setTerminalFocusRequest((current) => current + 1);
      return;
    }

    const currentMainWidth =
      mainSplitRef.current?.getBoundingClientRect().width;
    if (currentMainWidth) setMainWorkspaceFrozenWidth(currentMainWidth);
    setAiAssistantVisible(false);
    if (currentMainWidth) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    await synchronizeAiWindowWidth();
    if (!aiWindowShouldExpandRef.current) setMainWorkspaceFrozenWidth(null);
    setTerminalFocusRequest((current) => current + 1);
  }

  function toggleAiAssistant() {
    if (aiWindowShouldExpandRef.current || aiAssistantVisible) {
      void closeAiAssistant();
    } else {
      void openAiAssistant();
    }
  }

  function synchronizeAiWindowWidth() {
    if (!isTauri()) return Promise.resolve();
    aiWindowResizeQueueRef.current = aiWindowResizeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const shouldExpand = aiWindowShouldExpandRef.current;
        const expanded = aiWindowExpandedRef.current;
        const appliedExpansion = aiWindowExpansionRef.current;
        if (shouldExpand === expanded) return;

        const appWindow = getCurrentWindow();
        const scaleFactor = await appWindow.scaleFactor();
        const before = (await appWindow.innerSize()).toLogical(scaleFactor);
        const targetWidth = aiWindowTargetWidth(
          before.width,
          shouldExpand,
          appliedExpansion,
        );
        await appWindow.setSize(new LogicalSize(targetWidth, before.height));

        if (shouldExpand) {
          aiWindowExpandedRef.current = true;
          aiWindowExpansionRef.current = AI_SIDEBAR_DEFAULT_WIDTH;
          const after = (await appWindow.innerSize()).toLogical(scaleFactor);
          aiWindowExpansionRef.current = Math.max(
            0,
            after.width - before.width,
          );
        } else {
          aiWindowExpandedRef.current = false;
          aiWindowExpansionRef.current = 0;
        }
      })
      .catch((error) => {
        recordDiagnostic(
          "warn",
          "application.window",
          "AI 侧栏窗口尺寸调整失败",
          {
            error: commandErrorMessage(error),
          },
        );
      });
    return aiWindowResizeQueueRef.current;
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
    const remaining = current.filter((session) => !closingIds.has(session.id));
    sessionsRef.current = remaining;
    setSessions(remaining);
    setAiRemoteFileContexts((currentContexts) =>
      Object.fromEntries(
        Object.entries(currentContexts).filter(
          ([sessionId]) => !closingIds.has(sessionId),
        ),
      ),
    );
    setTerminalCurrentDirectories((currentDirectories) =>
      Object.fromEntries(
        Object.entries(currentDirectories).filter(
          ([sessionId]) => !closingIds.has(sessionId),
        ),
      ),
    );
    setAiBusinessContexts((currentContexts) =>
      Object.fromEntries(
        Object.entries(currentContexts).filter(
          ([sessionId]) => !closingIds.has(sessionId),
        ),
      ),
    );

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
            onSendToAi={(sessionId, request) =>
              void handoffToAi(sessionId, request)
            }
            onSnapshotChange={updateMonitorSnapshot}
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
        aiAssistantVisible={aiAssistantVisible}
        homeContent={
          <HostManagerPanel onConnect={openSession} settings={settings} />
        }
        onActiveSessionChange={setActiveSessionId}
        onCloseSession={closeSession}
        onOpenQuickCommands={() => setQuickCommandDrawerVisible(true)}
        onToggleAiAssistant={toggleAiAssistant}
        onOpenSettings={() => openAuxiliaryWindow("settings")}
        onOpenShortcutGuide={() => openAuxiliaryWindow("shortcuts")}
        renderSession={(session) => (
          <TerminalView
            active={session.id === activeSessionId}
            commandTrackingEnabled={settings.aiCommandTrackingEnabled}
            focusRequest={
              session.id === activeSessionId ? terminalFocusRequest : 0
            }
            injectedInput={terminalInjectedInputs[session.id]}
            settings={settings}
            session={session}
            onAskAi={(selection) => {
              setTerminalSelections((current) => ({
                ...current,
                [session.id]: selection,
              }));
              openAiAssistant("请解释这段终端输出，并给出排查建议。");
            }}
            onCommandLifecycle={setTerminalCommandSubmission}
            onCurrentDirectoryChange={updateTerminalCurrentDirectory}
            onRecentOutputChange={(output) =>
              setTerminalRecentOutputs((current) => {
                const next = output.slice(-settings.aiContextMaxChars);
                return current[session.id] === next
                  ? current
                  : { ...current, [session.id]: next };
              })
            }
            onSelectionChange={(selection) =>
              setTerminalSelections((current) =>
                current[session.id] ===
                selection.slice(0, settings.aiContextMaxChars)
                  ? current
                  : {
                      ...current,
                      [session.id]: selection.slice(
                        0,
                        settings.aiContextMaxChars,
                      ),
                    },
              )
            }
          />
        )}
        sessionContextMenuItems={sessionContextMenuItems}
        sessions={sessions}
      />
      <QuickCommandDrawer
        canSend={activeSession?.status === "connected"}
        commands={quickCommands}
        onAfterClose={() => setTerminalFocusRequest((current) => current + 1)}
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
      onCurrentPathChange={updateSftpCurrentPath}
      onSendFilesToAi={async (sessionId, files) => {
        if (sessionId !== activeSessionId) {
          throw new Error("当前会话已切换，请重新选择文件");
        }
        const nextFiles = mergeAiRemoteFileContexts(
          aiRemoteFileContexts[sessionId] ?? [],
          files,
        );
        setAiRemoteFileContexts((current) => ({
          ...current,
          [sessionId]: nextFiles,
        }));
        await openAiAssistant(
          "",
          files.map((file) => aiRemoteFileContextSource(file).id),
        );
      }}
      onSendSelectionToAi={(sessionId, currentDirectory, entries) =>
        handoffToAi(
          sessionId,
          createSftpSelectionAiHandoff(currentDirectory, entries),
        )
      }
      refreshRequest={
        activeSessionId ? (sftpRefreshRequests[activeSessionId] ?? 0) : 0
      }
      session={activeSession}
      showHiddenFiles={settings.showHiddenFiles}
      terminalDirectory={
        activeSessionId
          ? terminalCurrentDirectories[activeSessionId]
          : undefined
      }
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
      <div className="app-workspace">
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
          ref={mainSplitRef}
          style={
            mainWorkspaceFrozenWidth === null
              ? undefined
              : {
                  flex: `0 0 ${mainWorkspaceFrozenWidth}px`,
                  width: mainWorkspaceFrozenWidth,
                }
          }
        />
        <ResizeBox
          className={`ai-assistant-sidebar${
            aiAssistantVisible ? "" : " ai-assistant-sidebar-hidden"
          }`}
          directions={["left"]}
          onMoving={(_, size) => {
            const workspaceWidth =
              mainSplitRef.current?.parentElement?.getBoundingClientRect()
                .width ?? window.innerWidth;
            setAiSidebarWidth(clampAiSidebarWidth(size.width, workspaceWidth));
          }}
          onMovingEnd={() =>
            document.body.classList.remove("ai-sidebar-resizing")
          }
          onMovingStart={() =>
            document.body.classList.add("ai-sidebar-resizing")
          }
          width={aiSidebarWidth}
        >
          <AiAssistantPanel
            canInsertCommand={activeSession?.status === "connected"}
            commandSubmission={
              settings.aiCommandTrackingEnabled
                ? terminalCommandSubmission
                : null
            }
            contextSources={aiContextSources}
            hostId={activeSession?.host.id ?? null}
            hostName={activeSession?.host.name ?? ""}
            initialPrompt={aiInitialPrompt}
            initialContextIds={aiInitialContextIds}
            initialPromptRequest={aiInitialPromptRequest}
            onClose={closeAiAssistant}
            onAgentActionExecuted={handleAiAgentActionExecuted}
            onCommandPrepared={handleAiCommandPrepared}
            onRemoveRemoteFile={(sessionId, path) =>
              setAiRemoteFileContexts((current) => {
                const remaining = (current[sessionId] ?? []).filter(
                  (file) => file.path !== path,
                );
                if (remaining.length) {
                  return { ...current, [sessionId]: remaining };
                }
                const next = { ...current };
                delete next[sessionId];
                return next;
              })
            }
            remoteFiles={
              activeSessionId
                ? (aiRemoteFileContexts[activeSessionId] ?? [])
                : []
            }
            sessionId={activeSessionId}
            settings={settings}
            visible={aiAssistantVisible}
          />
        </ResizeBox>
      </div>
    </main>
  );
}

export default App;
