import { describe, expect, mock, test } from "bun:test";
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
  const lines = new Map<number, { isWrapped: boolean; text: string }>();
  const element = {
    classList: { add: (value: string) => classes.add(value) },
    style: {} as Record<string, string>,
    textContent: "",
  } as unknown as HTMLElement;
  let markerId = 0;
  const createMarker = () => {
    const state = {
      id: (markerId += 1),
      isDisposed: false,
      line: active.baseY + active.cursorY,
    };
    return {
      ...state,
      dispose: () => {
        state.isDisposed = true;
      },
      get isDisposed() {
        return state.isDisposed;
      },
      onDispose: () => disposable(),
    } as unknown as IMarker;
  };
  const active = {
    baseY: 0,
    cursorX: 4,
    cursorY: 0,
    getLine: (lineIndex: number) => {
      const line = lines.get(lineIndex);
      if (!line) return undefined;
      return {
        isWrapped: line.isWrapped,
        translateToString: (
          trimRight = false,
          startColumn = 0,
          endColumn = line.text.length,
        ) => {
          const value = line.text.slice(startColumn, endColumn);
          return trimRight ? value.trimEnd() : value;
        },
      };
    },
    type: "normal",
  };
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
    registerDecoration: (options: { marker: IMarker }) => {
      decorationOptions = options;
      return {
        dispose: () => undefined,
        element,
        marker: options.marker,
        onRender: (listener: (target: HTMLElement) => void) => {
          listener(element);
          return disposable();
        },
      } as unknown as IDecoration;
    },
    registerMarker: () => createMarker(),
  } as unknown as Terminal;
  return {
    active,
    callbacks,
    classes,
    decorationOptions: () => decorationOptions,
    element,
    setLine: (lineIndex: number, text: string, isWrapped = false) => {
      lines.set(lineIndex, { isWrapped, text });
    },
    terminal,
  };
}

function waitForInputResync() {
  return new Promise((resolve) => setTimeout(resolve, 45));
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

  test("resynchronizes input after native Tab completion redraws the line", async () => {
    const fake = fakeTerminal();
    const onSynchronizeInput = mock(() => undefined);
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: () => undefined,
      onSynchronizeInput,
    });
    addon.activate(fake.terminal);
    addon.setHistory(HISTORY);
    addon.setPromptReady(true);
    fake.setLine(0, "$   ");
    fake.callbacks.writeParsed?.();
    addon.synchronizeInput("unknown", true);

    const tab = keyboardEvent("Tab");
    expect(addon.handleKeyEvent(tab.event)).toBe(true);
    expect(tab.prevented()).toBe(false);
    addon.synchronizeInput("", false);
    fake.setLine(0, "$   git st");
    fake.active.cursorX = 10;
    fake.callbacks.writeParsed?.();
    await waitForInputResync();

    expect(onSynchronizeInput).toHaveBeenCalledWith("git st");
    expect(addon.suggestion).toBe("atus --short");
  });

  test("resynchronizes input after shell history navigation", async () => {
    const fake = fakeTerminal();
    const onSynchronizeInput = mock(() => undefined);
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: () => undefined,
      onSynchronizeInput,
    });
    addon.activate(fake.terminal);
    addon.setHistory(HISTORY);
    addon.setPromptReady(true);
    fake.setLine(0, "$   ");
    fake.callbacks.writeParsed?.();
    addon.synchronizeInput("local", true);

    const arrowUp = keyboardEvent("ArrowUp");
    expect(addon.handleKeyEvent(arrowUp.event)).toBe(true);
    addon.synchronizeInput("", false);
    fake.setLine(0, "$   git st");
    fake.active.cursorX = 10;
    fake.callbacks.writeParsed?.();
    await waitForInputResync();

    expect(onSynchronizeInput).toHaveBeenCalledWith("git st");
    expect(addon.suggestion).toBe("atus --short");
  });

  test("does not resynchronize when the cursor is inside existing text", async () => {
    const fake = fakeTerminal();
    const onSynchronizeInput = mock(() => undefined);
    const addon = new TerminalHistoryCompletionAddon({
      hostId: "host-1",
      getCurrentDirectory: () => "/srv/app",
      onAccept: () => undefined,
      onSynchronizeInput,
    });
    addon.activate(fake.terminal);
    addon.setPromptReady(true);
    fake.setLine(0, "$   ");
    fake.callbacks.writeParsed?.();

    expect(addon.handleKeyEvent(keyboardEvent("ArrowLeft").event)).toBe(true);
    addon.synchronizeInput("", false);
    fake.setLine(0, "$   git status");
    fake.active.cursorX = 10;
    fake.callbacks.writeParsed?.();
    await waitForInputResync();

    expect(onSynchronizeInput).not.toHaveBeenCalled();
    expect(addon.suggestion).toBeUndefined();
  });
});
