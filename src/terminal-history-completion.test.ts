import { describe, expect, test } from "bun:test";
import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { TerminalCommandHistoryRecord } from "./models";
import { TerminalHistoryCompletionAddon } from "./terminal-history-completion";

function disposable(onDispose = () => undefined): IDisposable {
  return { dispose: onDispose };
}

function keyboardEvent(key: string) {
  let prevented = false;
  let stopped = false;
  return {
    event: {
      altKey: false,
      ctrlKey: false,
      key,
      metaKey: false,
      preventDefault: () => {
        prevented = true;
      },
      shiftKey: false,
      stopPropagation: () => {
        stopped = true;
      },
      type: "keydown",
    } as unknown as KeyboardEvent,
    prevented: () => prevented,
    stopped: () => stopped,
  };
}

function fakeTerminal() {
  const callbacks: { resize?: () => void; writeParsed?: () => void } = {};
  const classes = new Set<string>();
  const element = {
    classList: { add: (value: string) => classes.add(value) },
    style: {} as Record<string, string>,
    textContent: "",
  } as unknown as HTMLElement;
  const marker = {
    dispose: () => undefined,
    id: 1,
    isDisposed: false,
    line: 0,
    onDispose: () => disposable(),
  } as unknown as IMarker;
  const decoration = {
    dispose: () => undefined,
    element,
    marker,
    onRender: (listener: (element: HTMLElement) => void) => {
      listener(element);
      return disposable();
    },
  } as unknown as IDecoration;
  const active = { cursorX: 4, type: "normal" };
  let decorationOptions: unknown;
  const terminal = {
    buffer: { active },
    cols: 80,
    onResize: (listener: () => void) => {
      callbacks.resize = listener;
      return disposable();
    },
    onWriteParsed: (listener: () => void) => {
      callbacks.writeParsed = listener;
      return disposable();
    },
    options: {
      allowProposedApi: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 14,
      fontWeight: 500,
      letterSpacing: 1,
      lineHeight: 1.2,
    },
    registerDecoration: (options: unknown) => {
      decorationOptions = options;
      return decoration;
    },
    registerMarker: () => marker,
  } as unknown as Terminal;
  return {
    active,
    callbacks,
    classes,
    decorationOptions: () => decorationOptions,
    element,
    terminal,
  };
}

const HISTORY: TerminalCommandHistoryRecord[] = [
  {
    id: "history-1",
    hostId: "host-1",
    command: "git status --short",
    cwd: "/srv/app",
    lastUsedAt: "2026-08-04T00:00:00.000Z",
    useCount: 2,
  },
];

describe("TerminalHistoryCompletionAddon", () => {
  test("renders a suggestion at the cursor and accepts only its suffix", () => {
    const accepted: string[] = [];
    const fake = fakeTerminal();
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: (suffix) => accepted.push(suffix),
    });
    addon.activate(fake.terminal);
    addon.setHistory(HISTORY);
    addon.setPromptReady(true);
    addon.synchronizeInput("git st", true);
    fake.callbacks.writeParsed?.();

    expect(addon.suggestion).toBe("atus --short");
    expect(fake.decorationOptions()).toMatchObject({ x: 4, layer: "top" });
    expect(fake.element.textContent).toBe("atus --short");
    expect(fake.classes.has("terminal-history-completion")).toBe(true);
    expect(fake.element.style.fontFamily).toBe(
      '"JetBrains Mono", monospace',
    );
    expect(fake.element.style.fontSize).toBe("14px");
    expect(fake.element.style.fontWeight).toBe("500");
    expect(fake.element.style.letterSpacing).toBe("1px");
    expect(fake.element.style.lineHeight).toBe("1.2");

    const tab = keyboardEvent("Tab");
    expect(addon.handleKeyEvent(tab.event)).toBe(false);
    expect(tab.prevented()).toBe(true);
    expect(tab.stopped()).toBe(true);
    expect(accepted).toEqual(["atus --short"]);
    expect(addon.suggestion).toBeUndefined();
  });

  test("leaves native Tab untouched when there is no suggestion", () => {
    const fake = fakeTerminal();
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: () => undefined,
    });
    addon.activate(fake.terminal);
    addon.setPromptReady(true);
    addon.synchronizeInput("unknown", true);

    const tab = keyboardEvent("Tab");
    expect(addon.handleKeyEvent(tab.event)).toBe(true);
    expect(tab.prevented()).toBe(false);
  });

  test("cancels with Escape and hides suggestions in alternate buffers", () => {
    const fake = fakeTerminal();
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: () => undefined,
    });
    addon.activate(fake.terminal);
    addon.setHistory(HISTORY);
    addon.setPromptReady(true);
    addon.synchronizeInput("git st", true);

    const escape = keyboardEvent("Escape");
    expect(addon.handleKeyEvent(escape.event)).toBe(false);
    expect(addon.suggestion).toBeUndefined();

    fake.active.type = "alternate";
    addon.synchronizeInput("git st", true);
    expect(addon.suggestion).toBeUndefined();
  });
});
