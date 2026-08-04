import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, Input, Message, Tooltip } from "@arco-design/web-react";
import type { RefInputType } from "@arco-design/web-react/es/Input";
import {
  IconClose,
  IconCopy,
  IconDown,
  IconPaste,
  IconRobot,
  IconSearch,
  IconSelectAll,
  IconUp,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import {
  SearchAddon,
  type ISearchOptions,
  type ISearchResultChangeEvent,
} from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession } from "../models";
import { TERMINAL_FONT_FAMILIES, type AppSettings } from "../app-settings";
import {
  consumeTerminalCommandCandidate,
  decodeSshOutput,
  EMPTY_TERMINAL_INPUT_STATE,
  isTerminalSessionOperational,
  isWindowsTerminalPasteShortcut,
  terminalStatusNoticeKey,
  terminalInjectedInputData,
  trackInjectedTerminalInput,
  type TerminalCommandSubmission,
  trackTerminalInput,
  type TerminalInjectedInput,
} from "../terminal-utils";
import {
  FINESHELL_OSC_ID,
  boundedShellCommandOutput,
  buildShellIntegrationInstallCommand,
  buildShellIntegrationUninstallCommand,
  createShellIntegrationEchoFilter,
  createShellIntegrationNonce,
  filterShellIntegrationEcho,
  parseShellIntegrationMessage,
  type ShellIntegrationEchoFilter,
} from "../shell-integration";
import { TERMINAL_THEMES } from "../terminal-themes";
import { diagnosticInvoke as invoke } from "../diagnostics";
import { listenProtocolEvent } from "../tauri-protocol";
import ConnectionStatusOverlay from "./ConnectionStatusOverlay";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

interface TerminalViewProps {
  active: boolean;
  commandTrackingEnabled: boolean;
  focusRequest: number;
  injectedInput?: TerminalInjectedInput;
  settings: AppSettings;
  session: TerminalSession;
  onAskAi: (selection: string) => void;
  onCommandLifecycle: (event: TerminalCommandSubmission) => void;
  onCurrentDirectoryChange: (sessionId: string, path: string) => void;
  onReconnect: () => void;
  onRecentOutputChange: (output: string) => void;
  onSelectionChange: (selection: string) => void;
}

interface PendingShellCommand {
  startLine: number;
  startedAtMs: number;
  submission: TerminalCommandSubmission;
}

type ShellIntegrationMutation = "install" | "uninstall";

const SHELL_INTEGRATION_TIMEOUT_MS = 8_000;

const EMPTY_SEARCH_RESULT: ISearchResultChangeEvent = {
  resultCount: 0,
  resultIndex: -1,
};

const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> =
  {
    activeMatchBackground: "#165dff",
    activeMatchBorder: "#94bfff",
    activeMatchColorOverviewRuler: "#165dff",
    matchBackground: "#6b5700",
    matchBorder: "#fadc19",
    matchOverviewRuler: "#fadc19",
  };

function searchOptions(
  caseSensitive: boolean,
  incremental = false,
): ISearchOptions {
  return {
    caseSensitive,
    decorations: TERMINAL_SEARCH_DECORATIONS,
    incremental,
  };
}

async function readClipboard() {
  if (isTauri()) return readClipboardText();
  if (!navigator.clipboard) throw new Error("当前环境无法读取剪贴板");
  return navigator.clipboard.readText();
}

async function writeClipboard(value: string) {
  if (isTauri()) return writeClipboardText(value);
  if (!navigator.clipboard) throw new Error("当前环境无法写入剪贴板");
  return navigator.clipboard.writeText(value);
}

function TerminalView({
  active,
  commandTrackingEnabled,
  focusRequest,
  injectedInput,
  settings,
  session,
  onAskAi,
  onCommandLifecycle,
  onCurrentDirectoryChange,
  onReconnect,
  onRecentOutputChange,
  onSelectionChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<RefInputType>(null);
  const connectedRef = useRef(isTerminalSessionOperational(session.status));
  const commandLifecycleRef = useRef(onCommandLifecycle);
  const commandTrackingEnabledRef = useRef(commandTrackingEnabled);
  const shellCommandResultsEnabledRef = useRef(commandTrackingEnabled);
  const shellIntegrationInstalledRef = useRef(false);
  const shellIntegrationNonceRef = useRef(createShellIntegrationNonce());
  const shellIntegrationStateRef = useRef<
    "disabled" | "installing" | "ready" | "unavailable"
  >("disabled");
  const shellIntegrationMutationRef = useRef<ShellIntegrationMutation>();
  const shellIntegrationEchoFilterRef = useRef<ShellIntegrationEchoFilter>();
  const shellIntegrationTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const startShellIntegrationMutationRef = useRef<
    (mutation: ShellIntegrationMutation) => void
  >(() => undefined);
  const settleShellIntegrationMutationRef = useRef<
    (result: "ready" | "disabled" | "unavailable") => void
  >(() => undefined);
  const pendingShellCommandsRef = useRef<PendingShellCommand[]>([]);
  const aiCommandCandidatesRef = useRef<string[]>([]);
  const inputStateRef = useRef({ ...EMPTY_TERMINAL_INPUT_STATE });
  const trackSubmittedCommandRef = useRef<(command: string) => void>(
    () => undefined,
  );
  const lastInjectedInputIdRef = useRef<string>();
  const recentOutputChangeRef = useRef(onRecentOutputChange);
  const selectionChangeRef = useRef(onSelectionChange);
  const currentDirectoryChangeRef = useRef(onCurrentDirectoryChange);
  const settingsRef = useRef(settings);
  const searchVisibleRef = useRef(false);
  const lastStatusNoticeRef = useRef<string>();
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResult, setSearchResult] =
    useState<ISearchResultChangeEvent>(EMPTY_SEARCH_RESULT);
  const [terminalReady, setTerminalReady] = useState(false);

  searchVisibleRef.current = searchVisible;
  settingsRef.current = settings;
  commandLifecycleRef.current = onCommandLifecycle;
  commandTrackingEnabledRef.current = commandTrackingEnabled;
  shellCommandResultsEnabledRef.current = commandTrackingEnabled;
  currentDirectoryChangeRef.current = onCurrentDirectoryChange;
  recentOutputChangeRef.current = onRecentOutputChange;
  selectionChangeRef.current = onSelectionChange;

  trackSubmittedCommandRef.current = (command) => {
    const candidate = consumeTerminalCommandCandidate(
      aiCommandCandidatesRef.current,
      command,
    );
    aiCommandCandidatesRef.current = candidate.candidates;
    if (!candidate.matched) return;
    const submittedAt = new Date().toISOString();
    const submission: TerminalCommandSubmission = {
      command,
      hostId: session.host.id,
      id: `terminal-command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phase: "submitted",
      sessionId: session.id,
      submittedAt,
    };
    commandLifecycleRef.current(submission);
    if (!shellCommandResultsEnabledRef.current) return;
    const terminal = terminalRef.current;
    if (shellIntegrationStateRef.current === "ready" && terminal) {
      const buffer = terminal.buffer.active;
      pendingShellCommandsRef.current.push({
        startLine: buffer.baseY + buffer.cursorY + 1,
        startedAtMs: Date.now(),
        submission,
      });
      return;
    }
    commandLifecycleRef.current({
      ...submission,
      completedAt: submittedAt,
      durationMs: 0,
      phase: "unavailable",
      reason:
        shellIntegrationStateRef.current === "unavailable"
          ? "当前远程 Shell 不支持结果关联"
          : "Shell Integration 尚未就绪",
    });
  };

  const clearShellIntegrationTimeout = () => {
    if (!shellIntegrationTimeoutRef.current) return;
    clearTimeout(shellIntegrationTimeoutRef.current);
    shellIntegrationTimeoutRef.current = undefined;
  };

  settleShellIntegrationMutationRef.current = (result) => {
    const mutation = shellIntegrationMutationRef.current;
    clearShellIntegrationTimeout();
    shellIntegrationMutationRef.current = undefined;
    shellIntegrationEchoFilterRef.current = undefined;
    if (result === "ready") {
      shellIntegrationInstalledRef.current = true;
      shellIntegrationStateRef.current = "ready";
    } else if (result === "disabled") {
      shellIntegrationInstalledRef.current = false;
      shellIntegrationStateRef.current = "disabled";
    } else {
      shellIntegrationInstalledRef.current = mutation === "uninstall";
      shellIntegrationStateRef.current = "unavailable";
    }
  };

  startShellIntegrationMutationRef.current = (mutation) => {
    if (
      !isTerminalSessionOperational(session.status) ||
      shellIntegrationMutationRef.current
    ) {
      return;
    }
    shellIntegrationMutationRef.current = mutation;
    if (mutation === "install") {
      shellIntegrationInstalledRef.current = true;
      shellIntegrationStateRef.current = "installing";
    }
    const command =
      mutation === "install"
        ? buildShellIntegrationInstallCommand(shellIntegrationNonceRef.current)
        : buildShellIntegrationUninstallCommand(
            shellIntegrationNonceRef.current,
          );
    shellIntegrationEchoFilterRef.current = createShellIntegrationEchoFilter(
      shellIntegrationNonceRef.current,
      mutation,
    );
    clearShellIntegrationTimeout();
    shellIntegrationTimeoutRef.current = setTimeout(() => {
      if (shellIntegrationMutationRef.current !== mutation) return;
      settleShellIntegrationMutationRef.current("unavailable");
    }, SHELL_INTEGRATION_TIMEOUT_MS);
    void invoke("ssh_write", {
      sessionId: session.id,
      data: Array.from(new TextEncoder().encode(command)),
    }).catch(() => {
      settleShellIntegrationMutationRef.current("unavailable");
    });
  };

  useEffect(() => {
    connectedRef.current = isTerminalSessionOperational(session.status);
    if (!isTerminalSessionOperational(session.status)) {
      currentDirectoryChangeRef.current(session.id, "");
      const completedAt = new Date().toISOString();
      for (const pending of pendingShellCommandsRef.current) {
        commandLifecycleRef.current({
          ...pending.submission,
          completedAt,
          durationMs: Math.max(0, Date.now() - pending.startedAtMs),
          phase: "unavailable",
          reason: "终端会话已断开，无法确认命令结果",
        });
      }
      pendingShellCommandsRef.current = [];
      shellIntegrationInstalledRef.current = false;
      shellIntegrationStateRef.current = "disabled";
      shellIntegrationMutationRef.current = undefined;
      shellIntegrationEchoFilterRef.current = undefined;
      clearShellIntegrationTimeout();
      aiCommandCandidatesRef.current = [];
      inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
    }
  }, [session.status]);

  useEffect(() => {
    if (commandTrackingEnabled) return;
    pendingShellCommandsRef.current = [];
    aiCommandCandidatesRef.current = [];
    inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
  }, [commandTrackingEnabled]);

  useEffect(() => {
    if (!isTerminalSessionOperational(session.status) || !terminalReady) return;
    if (!shellIntegrationInstalledRef.current) {
      if (!inputStateRef.current.reliable || inputStateRef.current.value) {
        shellIntegrationStateRef.current = "unavailable";
        return;
      }
      startShellIntegrationMutationRef.current("install");
    }
  }, [session.id, session.status, terminalReady]);

  useEffect(() => {
    if (
      !injectedInput ||
      lastInjectedInputIdRef.current === injectedInput.id
    ) {
      return;
    }
    lastInjectedInputIdRef.current = injectedInput.id;
    if (commandTrackingEnabled || injectedInput.submit) {
      aiCommandCandidatesRef.current = [
        ...aiCommandCandidatesRef.current.filter(
          (candidate) => candidate !== injectedInput.value,
        ),
        injectedInput.value,
      ].slice(-8);
      const tracked = trackInjectedTerminalInput(
        inputStateRef.current,
        injectedInput,
      );
      inputStateRef.current = tracked.state;
      tracked.submissions.forEach((command) =>
        trackSubmittedCommandRef.current(command),
      );
    }
    const data = terminalInjectedInputData(injectedInput);
    void invoke("ssh_write", {
      sessionId: session.id,
      data: Array.from(new TextEncoder().encode(data)),
    }).catch(() => undefined);
  }, [commandTrackingEnabled, injectedInput, session.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      cursorWidth: 1,
      fontFamily: TERMINAL_FONT_FAMILIES[settings.terminalFontFamily],
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight,
      overviewRuler: {
        width: 6,
      },
      scrollback: settings.terminalScrollback,
      theme: TERMINAL_THEMES[settings.terminalColorScheme].theme,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 1000 });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (!isWindowsTerminalPasteShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void pasteTerminalClipboard();
      return false;
    });
    terminalRef.current = terminal;
    lastStatusNoticeRef.current = undefined;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
    aiCommandCandidatesRef.current = [];
    pendingShellCommandsRef.current = [];
    lastInjectedInputIdRef.current = undefined;

    const fit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // The tab may be transitioning between visible and hidden states.
      }
    };
    let fitFrame: number | undefined;
    const scheduleFit = () => {
      if (fitFrame !== undefined) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined;
        fit();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);
    scheduleFit();

    const dataDisposable = terminal.onData((data) => {
      if (!connectedRef.current || shellIntegrationMutationRef.current) return;
      if (commandTrackingEnabledRef.current) {
        const tracked = trackTerminalInput(inputStateRef.current, data);
        inputStateRef.current = tracked.state;
        tracked.submissions.forEach((command) =>
          trackSubmittedCommandRef.current(command),
        );
      }
      void invoke("ssh_write", {
        sessionId: session.id,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(() => undefined);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!connectedRef.current) return;
      void invoke("ssh_resize", { sessionId: session.id, cols, rows }).catch(
        () => undefined,
      );
    });
    const searchDisposable = searchAddon.onDidChangeResults((result) => {
      setSearchResult(result);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      selectionChangeRef.current(terminal.getSelection());
      if (
        !settingsRef.current.terminalCopyOnSelect ||
        !terminal.hasSelection()
      ) {
        return;
      }
      void writeClipboard(terminal.getSelection()).catch(() => undefined);
    });
    const shellIntegrationDisposable = terminal.parser.registerOscHandler(
      FINESHELL_OSC_ID,
      (data) => {
        const message = parseShellIntegrationMessage(
          data,
          shellIntegrationNonceRef.current,
        );
        if (!message) return false;
        if (message.kind === "ready") {
          settleShellIntegrationMutationRef.current("ready");
          return true;
        }
        if (message.kind === "disabled") {
          settleShellIntegrationMutationRef.current("disabled");
          currentDirectoryChangeRef.current(session.id, "");
          queueMicrotask(() =>
            startShellIntegrationMutationRef.current("install"),
          );
          return true;
        }
        if (message.kind === "cwd") {
          currentDirectoryChangeRef.current(session.id, message.path);
          return true;
        }
        if (message.kind === "unavailable") {
          settleShellIntegrationMutationRef.current("unavailable");
          currentDirectoryChangeRef.current(session.id, "");
          const completedAt = new Date().toISOString();
          for (const pending of pendingShellCommandsRef.current) {
            commandLifecycleRef.current({
              ...pending.submission,
              completedAt,
              durationMs: Math.max(0, Date.now() - pending.startedAtMs),
              phase: "unavailable",
              reason: "当前远程 Shell 不支持结果关联",
            });
          }
          pendingShellCommandsRef.current = [];
          return true;
        }

        const pending = pendingShellCommandsRef.current.shift();
        if (!pending) return true;
        window.setTimeout(() => {
          const buffer = terminal.buffer.active;
          const endLine = buffer.baseY + buffer.cursorY;
          let rawOutput = "";
          for (
            let index = Math.max(0, pending.startLine);
            index <= endLine;
            index += 1
          ) {
            const line = buffer.getLine(index);
            if (!line) continue;
            const value = line.translateToString(true);
            rawOutput += line.isWrapped
              ? value
              : `${rawOutput ? "\n" : ""}${value}`;
          }
          const result = boundedShellCommandOutput(rawOutput);
          commandLifecycleRef.current({
            ...pending.submission,
            completedAt: new Date().toISOString(),
            durationMs: Math.max(0, Date.now() - pending.startedAtMs),
            exitCode: message.exitCode,
            output: result.output,
            outputTruncated: result.truncated,
            phase: "completed",
          });
        }, 0);
        return true;
      },
    );

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let recentOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const emitRecentOutput = () => {
      recentOutputTimer = undefined;
      const buffer = terminal.buffer.active;
      const start = Math.max(0, buffer.length - 100);
      let output = "";
      for (let index = start; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (!line) continue;
        const value = line.translateToString(true);
        if (line.isWrapped) output += value;
        else output += `${output ? "\n" : ""}${value}`;
      }
      recentOutputChangeRef.current(output.trimEnd());
    };
    const scheduleRecentOutput = () => {
      if (recentOutputTimer) return;
      recentOutputTimer = setTimeout(emitRecentOutput, 200);
    };
    void listenProtocolEvent("ssh-output", ({ payload }) => {
      if (payload.sessionId === session.id) {
        let data: Uint8Array<ArrayBufferLike> = decodeSshOutput(payload.data);
        if (shellIntegrationEchoFilterRef.current) {
          const filtered = filterShellIntegrationEcho(
            shellIntegrationEchoFilterRef.current,
            data,
          );
          data = filtered.data;
          shellIntegrationEchoFilterRef.current = filtered.filter;
        }
        if (data.length > 0) {
          terminal.write(data, scheduleRecentOutput);
        }
      }
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
        setTerminalReady(true);
      }
    });

    return () => {
      disposed = true;
      setTerminalReady(false);
      clearShellIntegrationTimeout();
      shellIntegrationMutationRef.current = undefined;
      shellIntegrationEchoFilterRef.current = undefined;
      unlisten?.();
      if (recentOutputTimer) clearTimeout(recentOutputTimer);
      resizeObserver.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      searchDisposable.dispose();
      selectionDisposable.dispose();
      shellIntegrationDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchVisible) return;
    if (!searchQuery) {
      searchAddon.clearDecorations();
      setSearchResult(EMPTY_SEARCH_RESULT);
      return;
    }
    searchAddon.findNext(searchQuery, searchOptions(searchCaseSensitive, true));
  }, [searchCaseSensitive, searchQuery, searchVisible]);

  useEffect(() => {
    if (!active || !searchVisible) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.dom.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, searchVisible]);

  useEffect(() => {
    if (!active || focusRequest <= 0) return;
    const frame = requestAnimationFrame(() => {
      if (searchVisibleRef.current) searchInputRef.current?.focus();
      else terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusRequest]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    terminal.options.cursorBlink = settings.terminalCursorBlink;
    terminal.options.cursorStyle = settings.terminalCursorStyle;
    terminal.options.cursorWidth = 1;
    terminal.options.fontFamily =
      TERMINAL_FONT_FAMILIES[settings.terminalFontFamily];
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.lineHeight = settings.terminalLineHeight;
    terminal.options.scrollback = settings.terminalScrollback;
    terminal.options.theme =
      TERMINAL_THEMES[settings.terminalColorScheme].theme;
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // The terminal can be hidden while another tab is active.
      }
    });
  }, [
    settings.terminalCursorBlink,
    settings.terminalCursorStyle,
    settings.terminalColorScheme,
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalLineHeight,
    settings.terminalScrollback,
  ]);

  useEffect(() => {
    if (!active) return;

    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (searchVisibleRef.current) {
        searchInputRef.current?.focus();
      } else {
        terminal.focus();
      }
      if (isTerminalSessionOperational(session.status)) {
        void invoke("ssh_resize", {
          sessionId: session.id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      }
    });
  }, [active, session.id, session.status]);

  useEffect(() => {
    if (!active) return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchVisible(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.dom.select();
        });
        return;
      }
      if (searchVisible && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        searchAddonRef.current?.clearDecorations();
        setSearchResult(EMPTY_SEARCH_RESULT);
        setSearchVisible(false);
        requestAnimationFrame(() => terminalRef.current?.focus());
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () =>
      window.removeEventListener("keydown", handleWindowKeyDown, true);
  }, [active, searchVisible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const noticeKey = terminalStatusNoticeKey(session.status, session.error);
    if (lastStatusNoticeRef.current === noticeKey) return;
    lastStatusNoticeRef.current = noticeKey;

    if (session.status === "connecting") {
      terminal.writeln(
        `\x1b[90m正在连接 ${session.host.username}@${session.host.address}:${session.host.port}...\x1b[0m`,
      );
    } else if (session.status === "reconnecting") {
      terminal.writeln("\r\n\x1b[90m正在重新连接...\x1b[0m");
    } else if (session.status === "failed" && session.error) {
      terminal.writeln(`\r\n\x1b[31m连接失败：${session.error}\x1b[0m`);
    } else if (session.status === "disconnected") {
      const detail = session.error ? `：${session.error}` : "";
      terminal.writeln(`\r\n\x1b[33m连接已断开${detail}\x1b[0m`);
    }
  }, [
    session.error,
    session.host.address,
    session.host.port,
    session.host.username,
    session.status,
  ]);

  function closeSearch() {
    searchAddonRef.current?.clearDecorations();
    setSearchResult(EMPTY_SEARCH_RESULT);
    setSearchVisible(false);
    requestAnimationFrame(() => terminalRef.current?.focus());
  }

  function findSearchMatch(direction: "next" | "previous") {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchQuery) return;
    const options = searchOptions(searchCaseSensitive);
    if (direction === "previous") {
      searchAddon.findPrevious(searchQuery, options);
    } else {
      searchAddon.findNext(searchQuery, options);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!searchVisible) return;
    const target = event.target;
    if (
      event.key === "Enter" &&
      target instanceof Element &&
      target.closest(".terminal-search-bar")
    ) {
      event.preventDefault();
      event.stopPropagation();
      findSearchMatch(event.shiftKey ? "previous" : "next");
    }
  }

  async function copyTerminalSelection() {
    const terminal = terminalRef.current;
    if (!terminal?.hasSelection()) return;
    try {
      await writeClipboard(terminal.getSelection());
    } catch {
      Message.error("无法写入剪贴板");
    } finally {
      terminal.focus();
    }
  }

  async function pasteTerminalClipboard() {
    const terminal = terminalRef.current;
    if (!terminal || !connectedRef.current) return;
    try {
      const value = await readClipboard();
      if (value) terminal.paste(value);
    } catch {
      Message.error("无法读取剪贴板");
    } finally {
      terminal.focus();
    }
  }

  function terminalContextMenuItems(): ContextMenuItem[] {
    const terminal = terminalRef.current;
    return [
      {
        key: "ask-ai",
        label: "使用 AI 解释",
        icon: <IconRobot />,
        disabled: !terminal?.hasSelection(),
        onClick: () => {
          if (terminal?.hasSelection()) onAskAi(terminal.getSelection());
        },
      },
      {
        key: "copy",
        label: "复制",
        icon: <IconCopy />,
        disabled: !terminal?.hasSelection(),
        onClick: copyTerminalSelection,
      },
      {
        key: "paste",
        label: "粘贴",
        icon: <IconPaste />,
        disabled: !connectedRef.current,
        onClick: pasteTerminalClipboard,
      },
      {
        key: "select-all",
        label: "全选",
        icon: <IconSelectAll />,
        dividerBefore: true,
        onClick: () => terminal?.selectAll(),
      },
    ];
  }

  function handleTerminalContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    if (settingsRef.current.terminalRightClickAction === "paste") {
      void pasteTerminalClipboard();
    }
  }

  const currentSearchResult =
    searchResult.resultIndex >= 0 ? searchResult.resultIndex + 1 : 0;
  const terminalTheme = TERMINAL_THEMES[settings.terminalColorScheme].theme;
  const reconnecting = session.status === "reconnecting";
  const connectionUnavailable =
    session.status === "failed" ||
    session.status === "disconnected" ||
    reconnecting;
  const connectionDescription = reconnecting
    ? "正在重新连接服务器"
    : session.error || "终端连接已断开";

  return (
    <div
      className="terminal-view"
      onKeyDownCapture={handleKeyDown}
      style={
        { "--terminal-background": terminalTheme.background } as CSSProperties
      }
    >
      <ContextMenu
        disabled={settings.terminalRightClickAction === "paste"}
        menuClassName="terminal-context-menu"
        resolveItems={terminalContextMenuItems}
      >
        <div
          className="terminal-host"
          onContextMenu={handleTerminalContextMenu}
          ref={containerRef}
        />
      </ContextMenu>
      {searchVisible && (
        <div className="terminal-search-bar" role="search">
          <Input
            aria-label="搜索终端内容"
            className="terminal-search-input"
            onChange={setSearchQuery}
            placeholder="搜索终端内容"
            prefix={<IconSearch />}
            ref={searchInputRef}
            size="mini"
            value={searchQuery}
          />
          <span aria-live="polite" className="terminal-search-result">
            {currentSearchResult} / {searchResult.resultCount}
          </span>
          <Tooltip content="区分大小写">
            <Button
              aria-label="区分大小写"
              aria-pressed={searchCaseSensitive}
              className={`terminal-search-case${searchCaseSensitive ? " is-active" : ""}`}
              onClick={() => setSearchCaseSensitive((value) => !value)}
              size="mini"
              type="text"
            >
              Aa
            </Button>
          </Tooltip>
          <Tooltip content="上一个匹配项">
            <Button
              aria-label="上一个匹配项"
              disabled={!searchQuery}
              icon={<IconUp />}
              onClick={() => findSearchMatch("previous")}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Tooltip content="下一个匹配项">
            <Button
              aria-label="下一个匹配项"
              disabled={!searchQuery}
              icon={<IconDown />}
              onClick={() => findSearchMatch("next")}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Tooltip content="关闭搜索">
            <Button
              aria-label="关闭搜索"
              icon={<IconClose />}
              onClick={closeSearch}
              size="mini"
              type="text"
            />
          </Tooltip>
        </div>
      )}
      {connectionUnavailable && (
        <ConnectionStatusOverlay
          description={connectionDescription}
          onReconnect={onReconnect}
          reconnecting={reconnecting}
        />
      )}
    </div>
  );
}

export default TerminalView;
