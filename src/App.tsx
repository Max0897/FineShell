import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Message, Typography } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import {
  IconClose,
  IconCloseCircle,
  IconPlus,
  IconPoweroff,
  IconRefresh,
} from "@arco-design/web-react/icon";
import type {
  QuickCommandRecord,
  ServerMonitorSnapshot,
  TerminalSession,
} from "./models";
import type { ContextMenuItem } from "./components/ContextMenu";
import HostManagerPanel from "./components/HostManagerPanel";
import QuickCommandDrawer from "./components/QuickCommandDrawer";
import SftpPanel from "./components/SftpPanel";
import SessionTabs from "./components/SessionTabs";
import AppWorkspaceLayout from "./components/AppWorkspaceLayout";
import ApplicationTitleBar from "./components/ApplicationTitleBar";
export { default as CollapsibleSplitTrigger } from "./components/CollapsibleSplitTrigger";
import { loadConfiguration } from "./config-database";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "./app-settings";
import { setAppearanceMode } from "./appearance";
import {
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
  aiRemoteFileContextSource,
  mergeAiRemoteFileContexts,
  formatAiServerContext,
} from "./ai-utils";
import { createSftpSelectionAiHandoff } from "./ai-handoff";
import { AI_SIDEBAR_DEFAULT_WIDTH } from "./ai-sidebar";
import { useAiSidebarController } from "./hooks/useAiSidebarController";
import useAiHandoffController from "./hooks/useAiHandoffController";
import {
  applicationUpdater,
  checkForApplicationUpdateOnStartup,
  restoreApplicationFocusAfterUpdateRelaunch,
  setApplicationUpdateNotice,
} from "./app-updater";
import { isTerminalSessionOperational } from "./terminal-utils";
import {
  nextTerminalFontSizeOffset,
  terminalFontSize,
  type TerminalFontZoomAction,
} from "./terminal-font-zoom";
import {
  configureDiagnosticLogging,
  diagnosticInvoke as invoke,
  recordDiagnostic,
} from "./diagnostics";
import {
  commandErrorMessage,
  FineShellCommandError,
  listenProtocolEvent,
  type AgentActionExecutionResult,
  verifyProtocolVersion,
} from "./tauri-protocol";
import {
  openAuxiliaryWindow,
  promptStartupApplicationUpdate,
} from "./app-window-actions";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
const ServerMonitorPanel = lazy(
  () => import("./components/ServerMonitorPanel"),
);
const loadAiAssistantPanel = () => import("./components/AiAssistantPanel");
const AiAssistantPanel = lazy(loadAiAssistantPanel);
const TerminalView = lazy(() => import("./components/TerminalView"));

function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [quickCommands, setQuickCommands] = useState<QuickCommandRecord[]>([]);
  const [quickCommandDrawerVisible, setQuickCommandDrawerVisible] =
    useState(false);
  const [serverMonitorCollapsed, setServerMonitorCollapsed] = useState(false);
  const [sftpCollapsed, setSftpCollapsed] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(
    AI_SIDEBAR_DEFAULT_WIDTH,
  );
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
  const [terminalFontSizeOffset, setTerminalFontSizeOffset] = useState(0);
  const mainSplitRef = useRef<HTMLElement | null>(null);
  const handleSessionsClosed = useCallback((closingIds: Set<string>) => {
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
  }, []);
  const {
    activeSession,
    activeSessionId,
    closeSession,
    closeSessions,
    disconnectSession,
    openSession,
    reconnectSession,
    sessions,
    setActiveSessionId,
    syncKnownHostFingerprints,
    updatePortForwardStatus,
  } = useTerminalSessions({ onSessionsClosed: handleSessionsClosed });
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const {
    active: aiAssistantActive,
    close: closeAiSidebar,
    frozenWorkspaceWidth: mainWorkspaceFrozenWidth,
    mounted: aiAssistantMounted,
    open: openAiSidebar,
    phase: aiSidebarPhase,
    visible: aiAssistantVisible,
  } = useAiSidebarController({
    getWorkspaceWidth: () =>
      mainSplitRef.current?.getBoundingClientRect().width,
    onResizeFailure: (error, operation) => {
      recordDiagnostic(
        "warn",
        "application.window",
        operation === "expand" ? "AI 侧栏窗口扩宽失败" : "AI 侧栏窗口还原失败",
        { error: commandErrorMessage(error) },
      );
      Message.warning(
        operation === "expand"
          ? "窗口无法扩宽，AI 助手已在当前窗口内打开"
          : "窗口尺寸无法自动还原，请手动调整",
      );
    },
    sidebarWidth: aiSidebarWidth,
  });
  const openAiAssistant = useCallback(
    async (
      sessionId: string,
      prompt = "",
      contextIds: AiContextSourceId[] = [],
    ) => {
      if (activeSessionIdRef.current !== sessionId) return false;
      await loadAiAssistantPanel();
      if (activeSessionIdRef.current !== sessionId) return false;
      setAiInitialPrompt(prompt);
      setAiInitialContextIds(contextIds);
      setAiInitialPromptRequest((current) => current + 1);
      await openAiSidebar();
      return true;
    },
    [openAiSidebar],
  );
  const showAiHandoffNotice = useCallback(
    (type: "error" | "warning", content: string) => {
      Message[type](content);
    },
    [],
  );
  const { handoffContext, handoffRemoteFiles, handoffTerminalSelection } =
    useAiHandoffController({
      activeSession,
      businessContexts: aiBusinessContexts,
      onNotice: showAiHandoffNotice,
      openAssistant: openAiAssistant,
      remoteFileContexts: aiRemoteFileContexts,
      setBusinessContexts: setAiBusinessContexts,
      setRemoteFileContexts: setAiRemoteFileContexts,
      setTerminalSelections,
      terminalSelections,
    });
  const previousAiSidebarPhaseRef = useRef(aiSidebarPhase);

  const runtimeTerminalFontSize = terminalFontSize(
    settings.terminalFontSize,
    terminalFontSizeOffset,
  );
  const zoomTerminalFont = useCallback(
    (action: TerminalFontZoomAction) => {
      setTerminalFontSizeOffset((currentOffset) =>
        nextTerminalFontSizeOffset(
          settings.terminalFontSize,
          currentOffset,
          action,
        ),
      );
    },
    [settings.terminalFontSize],
  );

  useEffect(() => {
    setTerminalFontSizeOffset(0);
  }, [settings.terminalFontSize]);

  useEffect(() => {
    if (
      aiSidebarPhase === "closed" &&
      previousAiSidebarPhaseRef.current !== "closed"
    ) {
      setTerminalFocusRequest((current) => current + 1);
    }
    previousAiSidebarPhaseRef.current = aiSidebarPhase;
  }, [aiSidebarPhase]);

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
        setAppearanceMode(configuration.settings.appearanceMode, {
          persist: true,
        });
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
              void restoreApplicationFocusAfterUpdateRelaunch()
                .then((focused) => {
                  if (focused) {
                    recordDiagnostic(
                      "info",
                      "application.update",
                      "更新重启后主窗口已恢复前台",
                    );
                  }
                })
                .catch((error) => {
                  recordDiagnostic(
                    "warn",
                    "application.update",
                    "更新重启后主窗口聚焦失败",
                    { error: commandErrorMessage(error) },
                  );
                });
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
          syncKnownHostFingerprints(configuration.knownHosts);
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
  }, [syncKnownHostFingerprints]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("settings:changed", ({ payload }) => {
      const nextSettings = sanitizeAppSettings(payload);
      setSettings(nextSettings);
      setAppearanceMode(nextSettings.appearanceMode, { persist: true });
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
      closeAiSidebar();
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
  }, [activeSessionId, closeAiSidebar]);

  async function sendQuickCommand(command: string, execute: boolean) {
    if (!activeSession || !isTerminalSessionOperational(activeSession.status)) {
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

  async function toggleAiAssistant() {
    if (!activeSession) {
      Message.warning("请先打开终端会话");
      return;
    }
    if (aiAssistantActive) {
      await closeAiSidebar();
      return;
    }
    await loadAiAssistantPanel();
    await openAiSidebar();
  }

  function sessionContextMenuItems(
    session: TerminalSession,
  ): ContextMenuItem[] {
    const canDisconnect =
      session.status === "connecting" ||
      isTerminalSessionOperational(session.status) ||
      session.status === "reconnecting";
    const canReconnect =
      session.status !== "connecting" && session.status !== "reconnecting";

    return [
      {
        key: "open-new-session",
        label: "新开会话",
        icon: <IconPlus />,
        onClick: () =>
          openSession(session.host, session.proxy, session.jumpHost),
      },
      {
        key: "disconnect",
        label: "断开连接",
        icon: <IconPoweroff />,
        disabled: !canDisconnect,
        dividerBefore: true,
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
            onReconnect={() => {
              if (activeSession) reconnectSession(activeSession);
            }}
            onSendToAi={(sessionId, request) =>
              void handoffContext(sessionId, request)
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
        aiAssistantVisible={aiAssistantActive}
        hasActiveSession={Boolean(activeSession)}
        homeContent={
          <HostManagerPanel onConnect={openSession} settings={settings} />
        }
        onActiveSessionChange={setActiveSessionId}
        onCloseSession={closeSession}
        onToggleAiAssistant={toggleAiAssistant}
        renderSession={(session) => (
          <Suspense fallback={null}>
            <TerminalView
              active={session.id === activeSessionId}
              focusRequest={
                session.id === activeSessionId ? terminalFocusRequest : 0
              }
              onFontZoom={zoomTerminalFont}
              settings={settings}
              session={session}
              terminalFontSize={runtimeTerminalFontSize}
              onAskAi={(selection) => {
                void handoffTerminalSelection(session.id, selection);
              }}
              onCurrentDirectoryChange={updateTerminalCurrentDirectory}
              onReconnect={() => reconnectSession(session)}
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
          </Suspense>
        )}
        sessionContextMenuItems={sessionContextMenuItems}
        sessions={sessions}
      />
      <QuickCommandDrawer
        canSend={Boolean(
          activeSession && isTerminalSessionOperational(activeSession.status),
        )}
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
      onReconnect={() => {
        if (activeSession) reconnectSession(activeSession);
      }}
      onSendFilesToAi={async (sessionId, files) => {
        await handoffRemoteFiles(sessionId, files);
      }}
      onSendSelectionToAi={async (sessionId, currentDirectory, entries) => {
        await handoffContext(
          sessionId,
          createSftpSelectionAiHandoff(currentDirectory, entries),
        );
      }}
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

  const aiAssistantPanel = aiAssistantMounted ? (
    <Suspense fallback={<div className="ai-assistant-sidebar-panel" />}>
      <AiAssistantPanel
        canInsertCommand={Boolean(
          activeSession && isTerminalSessionOperational(activeSession.status),
        )}
        contextSources={aiContextSources}
        hostId={activeSession?.host.id ?? null}
        hostName={activeSession?.host.name ?? ""}
        initialPrompt={aiInitialPrompt}
        initialContextIds={aiInitialContextIds}
        initialPromptRequest={aiInitialPromptRequest}
        onAgentActionExecuted={handleAiAgentActionExecuted}
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
          activeSessionId ? (aiRemoteFileContexts[activeSessionId] ?? []) : []
        }
        sessionId={activeSessionId}
        settings={settings}
        visible={aiAssistantVisible}
      />
    </Suspense>
  ) : null;

  return (
    <AppWorkspaceLayout
      applicationTitleBar={
        <ApplicationTitleBar
          hasActiveSession={Boolean(activeSession)}
          onOpenQuickCommands={() => setQuickCommandDrawerVisible(true)}
          onOpenSettings={() => openAuxiliaryWindow("settings")}
          onOpenShortcutGuide={() => openAuxiliaryWindow("shortcuts")}
          onToggleServerMonitor={() =>
            setServerMonitorCollapsed((collapsed) => !collapsed)
          }
          onToggleSftp={() => setSftpCollapsed((collapsed) => !collapsed)}
          serverMonitorCollapsed={serverMonitorCollapsed}
          sftpCollapsed={sftpCollapsed}
        />
      }
      aiAssistantPanel={aiAssistantPanel}
      aiAssistantMounted={aiAssistantMounted}
      aiAssistantOpening={aiSidebarPhase === "opening"}
      aiSidebarWidth={aiSidebarWidth}
      frozenWorkspaceWidth={mainWorkspaceFrozenWidth}
      mainSplitRef={mainSplitRef}
      onAiSidebarWidthChange={setAiSidebarWidth}
      serverMonitorCollapsed={serverMonitorCollapsed}
      serverMonitorPanel={serverMonitorPanel}
      sftpCollapsed={sftpCollapsed}
      sftpPanel={sftpPanel}
      terminalPanel={terminalPanel}
    />
  );
}

export default App;
