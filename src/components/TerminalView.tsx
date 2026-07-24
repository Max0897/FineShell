import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Input,
  Tooltip,
} from "@arco-design/web-react";
import type { RefInputType } from "@arco-design/web-react/es/Input";
import {
  IconClose,
  IconDown,
  IconSearch,
  IconUp,
} from "@arco-design/web-react/icon";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { decodeSshOutput } from "../terminal-utils";

interface TerminalViewProps {
  active: boolean;
  settings: AppSettings;
  session: TerminalSession;
}

interface SshOutputPayload {
  sessionId: string;
  data: string;
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

function TerminalView({ active, settings, session }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<RefInputType>(null);
  const connectedRef = useRef(session.status === "connected");
  const searchVisibleRef = useRef(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResult, setSearchResult] =
    useState<ISearchResultChangeEvent>(EMPTY_SEARCH_RESULT);

  searchVisibleRef.current = searchVisible;

  useEffect(() => {
    connectedRef.current = session.status === "connected";
  }, [session.status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      fontFamily: TERMINAL_FONT_FAMILIES[settings.terminalFontFamily],
      fontSize: settings.terminalFontSize,
      lineHeight: 1.2,
      overviewRuler: {
        width: 6,
      },
      scrollback: settings.terminalScrollback,
      theme: {
        background: "#191b20",
        foreground: "#d7dae0",
        cursor: "#23c343",
        cursorAccent: "#191b20",
        scrollbarSliderActiveBackground: "#4e5969",
        scrollbarSliderBackground: "#c9cdd4",
        scrollbarSliderHoverBackground: "#86909c",
        selectionBackground: "#3b4354",
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 1000 });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

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

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SshOutputPayload>("ssh-output", ({ payload }) => {
      if (payload.sessionId === session.id) {
        terminal.write(decodeSshOutput(payload.data));
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
      resizeObserver.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      searchDisposable.dispose();
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
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    terminal.options.cursorBlink = settings.terminalCursorBlink;
    terminal.options.cursorStyle = settings.terminalCursorStyle;
    terminal.options.fontFamily =
      TERMINAL_FONT_FAMILIES[settings.terminalFontFamily];
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.scrollback = settings.terminalScrollback;
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
    settings.terminalFontFamily,
    settings.terminalFontSize,
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

  const currentSearchResult =
    searchResult.resultIndex >= 0 ? searchResult.resultIndex + 1 : 0;

  return (
    <div className="terminal-view" onKeyDownCapture={handleKeyDown}>
      <div className="terminal-host" ref={containerRef} />
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
