import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
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

function TerminalView({ active, settings, session }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(session.status === "connected");

  useEffect(() => {
    connectedRef.current = session.status === "connected";
  }, [session.status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      fontFamily: TERMINAL_FONT_FAMILIES[settings.terminalFontFamily],
      fontSize: settings.terminalFontSize,
      lineHeight: 1.2,
      scrollback: settings.terminalScrollback,
      theme: {
        background: "#191b20",
        foreground: "#d7dae0",
        cursor: "#23c343",
        cursorAccent: "#191b20",
        selectionBackground: "#3b4354",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

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
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id]);

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
      terminal.focus();
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

  return <div className="terminal-view" ref={containerRef} />;
}

export default TerminalView;
