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
import {
  TERMINAL_FONT_FAMILIES,
  type AppSettings,
} from "../app-settings";
import {
  appendInjectedTerminalInput,
  consumeTerminalCommandCandidate,
  decodeSshOutput,
  EMPTY_TERMINAL_INPUT_STATE,
  terminalStatusNoticeKey,
  trackTerminalInput,
  type TerminalInjectedInput,
} from "../terminal-utils";
import { TERMINAL_THEMES } from "../terminal-themes";
import { diagnosticInvoke as invoke } from "../diagnostics";
import { listenProtocolEvent } from "../tauri-protocol";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

interface TerminalViewProps {
  active: boolean;
  commandTrackingEnabled: boolean;
  focusRequest: number;
  injectedInput?: TerminalInjectedInput;
  settings: AppSettings;
  session: TerminalSession;
  onAskAi: (selection: string) => void;
  onCommandSubmit: (command: string) => void;
  onRecentOutputChange: (output: string) => void;
  onSelectionChange: (selection: string) => void;
}

const EMPTY_SEARCH_RESULT: ISearchResultChangeEvent = {
  resultCount: 0,
  resultIndex: -1,
};

const TERMINAL_SEARCH_DECORATIONS: NonNullable<
  ISearchOptions["decorations"]
> = {
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
  onCommandSubmit,
  onRecentOutputChange,
  onSelectionChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<RefInputType>(null);
  const connectedRef = useRef(session.status === "connected");
  const commandSubmitRef = useRef(onCommandSubmit);
  const commandTrackingEnabledRef = useRef(commandTrackingEnabled);
  const aiCommandCandidatesRef = useRef<string[]>([]);
  const inputStateRef = useRef({ ...EMPTY_TERMINAL_INPUT_STATE });
  const lastInjectedInputIdRef = useRef<string>();
  const recentOutputChangeRef = useRef(onRecentOutputChange);
  const selectionChangeRef = useRef(onSelectionChange);
  const settingsRef = useRef(settings);
  const searchVisibleRef = useRef(false);
  const lastStatusNoticeRef = useRef<string>();
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResult, setSearchResult] =
    useState<ISearchResultChangeEvent>(EMPTY_SEARCH_RESULT);

  searchVisibleRef.current = searchVisible;
  settingsRef.current = settings;
  commandSubmitRef.current = onCommandSubmit;
  commandTrackingEnabledRef.current = commandTrackingEnabled;
  recentOutputChangeRef.current = onRecentOutputChange;
  selectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    connectedRef.current = session.status === "connected";
    if (session.status !== "connected") {
      aiCommandCandidatesRef.current = [];
      inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
    }
  }, [session.status]);

  useEffect(() => {
    if (commandTrackingEnabled) return;
    aiCommandCandidatesRef.current = [];
    inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
  }, [commandTrackingEnabled]);

  useEffect(() => {
    if (
      !commandTrackingEnabled ||
      !injectedInput ||
      lastInjectedInputIdRef.current === injectedInput.id
    ) {
      return;
    }
    lastInjectedInputIdRef.current = injectedInput.id;
    aiCommandCandidatesRef.current = [
      ...aiCommandCandidatesRef.current.filter(
        (candidate) => candidate !== injectedInput.value,
      ),
      injectedInput.value,
    ].slice(-8);
    inputStateRef.current = appendInjectedTerminalInput(
      inputStateRef.current,
      injectedInput.value,
    );
  }, [commandTrackingEnabled, injectedInput]);

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
    terminalRef.current = terminal;
    lastStatusNoticeRef.current = undefined;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    inputStateRef.current = { ...EMPTY_TERMINAL_INPUT_STATE };
    aiCommandCandidatesRef.current = [];
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
      if (!connectedRef.current) return;
      if (commandTrackingEnabledRef.current) {
        const tracked = trackTerminalInput(inputStateRef.current, data);
        inputStateRef.current = tracked.state;
        for (const command of tracked.submissions) {
          const candidate = consumeTerminalCommandCandidate(
            aiCommandCandidatesRef.current,
            command,
          );
          aiCommandCandidatesRef.current = candidate.candidates;
          if (!candidate.matched) continue;
          commandSubmitRef.current(command);
        }
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
        terminal.write(decodeSshOutput(payload.data), scheduleRecentOutput);
      }
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
      if (recentOutputTimer) clearTimeout(recentOutputTimer);
      resizeObserver.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      searchDisposable.dispose();
      selectionDisposable.dispose();
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
    searchAddon.findNext(
      searchQuery,
      searchOptions(searchCaseSensitive, true),
    );
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
      if (session.status === "connected") {
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
    return () => window.removeEventListener("keydown", handleWindowKeyDown, true);
  }, [active, searchVisible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const noticeKey = terminalStatusNoticeKey(
      session.status,
      session.error,
    );
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
    </div>
  );
}

export default TerminalView;
