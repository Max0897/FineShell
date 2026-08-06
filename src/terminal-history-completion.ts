import type {
  IDecoration,
  IDisposable,
  IMarker,
  ITerminalAddon,
  Terminal,
} from "@xterm/xterm";
import type { TerminalCommandHistoryRecord } from "./models";
import { findTerminalHistoryCompletion } from "./terminal-command-history";

export interface TerminalHistoryCompletionOptions {
  hostId: string;
  getCurrentDirectory: () => string | undefined;
  onAccept: (suffix: string) => void;
  onSynchronizeInput?: (commandLine: string) => void;
  ghostTextColor?: string;
}

const INPUT_RESYNC_DELAY_MS = 32;
const NATIVE_LINE_EDIT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Delete",
  "End",
  "Home",
  "Tab",
]);

export class TerminalHistoryCompletionAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private history: readonly TerminalCommandHistoryRecord[] = [];
  private commandLine = "";
  private inputReliable = true;
  private promptReady = false;
  private capturePromptAnchor = false;
  private inputResyncRequested = false;
  private inputResyncTimer?: ReturnType<typeof setTimeout>;
  private promptAnchor?: { marker: IMarker; x: number };
  private suggestionValue?: string;
  private decoration?: IDecoration;
  private decorationRenderDisposable?: IDisposable;
  private marker?: IMarker;
  private readonly disposables: IDisposable[] = [];

  public constructor(
    private readonly options: TerminalHistoryCompletionOptions,
  ) {}

  public get suggestion() {
    return this.suggestionValue;
  }

  public activate(terminal: Terminal) {
    if (this.terminal) {
      throw new Error("TerminalHistoryCompletionAddon is already active");
    }
    if (!terminal.options.allowProposedApi) {
      throw new Error(
        "TerminalHistoryCompletionAddon requires allowProposedApi for decorations",
      );
    }
    this.terminal = terminal;
    this.disposables.push(
      terminal.onWriteParsed(() => this.handleWriteParsed()),
      terminal.onResize(() => this.refreshDecoration()),
    );
  }

  public setHistory(history: readonly TerminalCommandHistoryRecord[]) {
    this.history = history;
    this.updateSuggestion();
    this.refreshDecoration();
  }

  public setPromptReady(ready: boolean) {
    this.promptReady = ready;
    if (ready) {
      this.capturePromptAnchor = true;
    } else {
      this.capturePromptAnchor = false;
      this.inputResyncRequested = false;
      this.clearInputResyncTimer();
      this.clearPromptAnchor();
    }
    this.updateSuggestion();
    if (!ready) this.clearVisual();
  }

  public refresh() {
    this.updateSuggestion();
    this.refreshDecoration();
  }

  public synchronizeInput(commandLine: string, reliable: boolean) {
    this.commandLine = commandLine;
    this.inputReliable = reliable;
    this.updateSuggestion();
    this.clearVisual();
  }

  public handleKeyEvent(event: KeyboardEvent) {
    if (
      event.type !== "keydown" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return true;
    }
    if (event.key === "Tab" && this.suggestionValue) {
      event.preventDefault();
      event.stopPropagation();
      this.accept();
      return false;
    }
    if (event.key === "Escape" && this.suggestionValue) {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      return false;
    }
    if (NATIVE_LINE_EDIT_KEYS.has(event.key)) {
      this.requestInputResync();
    }
    return true;
  }

  public accept() {
    const suffix = this.suggestionValue;
    if (!suffix) return undefined;
    this.commandLine += suffix;
    this.suggestionValue = undefined;
    this.clearVisual();
    this.options.onAccept(suffix);
    return suffix;
  }

  public cancel() {
    this.suggestionValue = undefined;
    this.clearVisual();
  }

  public dispose() {
    this.cancel();
    this.clearInputResyncTimer();
    this.clearPromptAnchor();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.terminal = undefined;
  }

  private handleWriteParsed() {
    if (this.capturePromptAnchor) {
      this.capturePromptAnchor = false;
      this.updatePromptAnchor();
    }
    if (this.inputResyncRequested) this.scheduleInputResync();
    this.refreshDecoration();
  }

  private requestInputResync() {
    if (!this.promptReady || !this.promptAnchor) return;
    this.inputResyncRequested = true;
    this.inputReliable = false;
    this.suggestionValue = undefined;
    this.clearVisual();
  }

  private scheduleInputResync() {
    this.clearInputResyncTimer();
    this.inputResyncTimer = setTimeout(() => {
      this.inputResyncTimer = undefined;
      this.synchronizeInputFromBuffer();
    }, INPUT_RESYNC_DELAY_MS);
  }

  private clearInputResyncTimer() {
    if (this.inputResyncTimer === undefined) return;
    clearTimeout(this.inputResyncTimer);
    this.inputResyncTimer = undefined;
  }

  private updatePromptAnchor() {
    const terminal = this.terminal;
    if (!terminal || terminal.buffer.active.type === "alternate") return;
    this.clearPromptAnchor();
    this.promptAnchor = {
      marker: terminal.registerMarker(0),
      x: terminal.buffer.active.cursorX,
    };
  }

  private clearPromptAnchor() {
    this.promptAnchor?.marker.dispose();
    this.promptAnchor = undefined;
  }

  private synchronizeInputFromBuffer() {
    if (!this.inputResyncRequested) return;
    const commandLine = this.readInputFromBuffer();
    if (commandLine === undefined) return;
    this.inputResyncRequested = false;
    this.commandLine = commandLine;
    this.inputReliable = true;
    this.options.onSynchronizeInput?.(commandLine);
    this.updateSuggestion();
    this.refreshDecoration();
  }

  private readInputFromBuffer() {
    const terminal = this.terminal;
    const anchor = this.promptAnchor;
    if (
      !terminal ||
      !anchor ||
      anchor.marker.isDisposed ||
      anchor.marker.line < 0 ||
      terminal.buffer.active.type === "alternate"
    ) {
      return undefined;
    }

    const buffer = terminal.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    if (cursorLine < anchor.marker.line) return undefined;
    const cursorBufferLine = buffer.getLine(cursorLine);
    if (!cursorBufferLine) return undefined;
    if (cursorBufferLine.translateToString(true, buffer.cursorX)) {
      return undefined;
    }

    let inputStartLine = cursorLine;
    while (inputStartLine > anchor.marker.line) {
      const line = buffer.getLine(inputStartLine);
      if (!line?.isWrapped) break;
      inputStartLine -= 1;
    }
    if (inputStartLine < anchor.marker.line) return undefined;

    let commandLine = "";
    for (let lineIndex = inputStartLine; lineIndex <= cursorLine; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) return undefined;
      const startColumn = lineIndex === inputStartLine ? anchor.x : 0;
      const endColumn = lineIndex === cursorLine ? buffer.cursorX : terminal.cols;
      if (endColumn < startColumn) return undefined;
      commandLine += line.translateToString(true, startColumn, endColumn);
    }
    if (
      commandLine.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(commandLine)
    ) {
      return undefined;
    }
    return commandLine;
  }

  private updateSuggestion() {
    const terminal = this.terminal;
    if (
      !terminal ||
      !this.promptReady ||
      !this.inputReliable ||
      terminal.buffer.active.type === "alternate"
    ) {
      this.suggestionValue = undefined;
      return;
    }
    this.suggestionValue = findTerminalHistoryCompletion(this.history, {
      hostId: this.options.hostId,
      commandLine: this.commandLine,
      cwd: this.options.getCurrentDirectory(),
    })?.suffix;
  }

  private refreshDecoration() {
    const terminal = this.terminal;
    const suggestion = this.suggestionValue;
    this.clearVisual();
    if (
      !terminal ||
      !suggestion ||
      !this.promptReady ||
      terminal.buffer.active.type === "alternate"
    ) {
      return;
    }

    const cursorX = terminal.buffer.active.cursorX;
    const fitted = fitGhostText(
      suggestion,
      Math.max(1, terminal.cols - cursorX),
    );
    if (!fitted.text) return;
    const marker = terminal.registerMarker(0);
    const decoration = terminal.registerDecoration({
      marker,
      x: cursorX,
      width: fitted.width,
      layer: "top",
    });
    if (!decoration) {
      marker.dispose();
      return;
    }
    const render = (element: HTMLElement) => {
      const fontSize = terminal.options.fontSize ?? 15;
      element.classList.add("terminal-history-completion");
      element.textContent = fitted.text;
      element.style.color = this.options.ghostTextColor ?? "#86909c";
      element.style.fontFamily = terminal.options.fontFamily ?? "monospace";
      element.style.fontSize = `${fontSize}px`;
      element.style.fontWeight = String(
        terminal.options.fontWeight ?? "normal",
      );
      element.style.fontVariantLigatures = "none";
      element.style.letterSpacing = `${terminal.options.letterSpacing ?? 0}px`;
      element.style.lineHeight = String(terminal.options.lineHeight ?? 1);
      element.style.opacity = "0.78";
      element.style.overflow = "visible";
      element.style.pointerEvents = "none";
      element.style.whiteSpace = "pre";
      element.style.zIndex = "3";
    };
    this.marker = marker;
    this.decoration = decoration;
    this.decorationRenderDisposable = decoration.onRender(render);
    if (decoration.element) render(decoration.element);
  }

  private clearVisual() {
    this.decorationRenderDisposable?.dispose();
    this.decorationRenderDisposable = undefined;
    this.decoration?.dispose();
    this.decoration = undefined;
    this.marker?.dispose();
    this.marker = undefined;
  }
}

function characterCellWidth(character: string) {
  if (/\p{Mark}/u.test(character)) return 0;
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    /\p{Extended_Pictographic}/u.test(character) ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6)))
  ) {
    return 2;
  }
  return 1;
}

function textCellWidth(value: string) {
  return Array.from(value).reduce(
    (width, character) => width + characterCellWidth(character),
    0,
  );
}

function takeCells(value: string, limit: number) {
  let width = 0;
  let text = "";
  for (const character of Array.from(value)) {
    const characterWidth = characterCellWidth(character);
    if (width + characterWidth > limit) break;
    text += character;
    width += characterWidth;
  }
  return { text, width };
}

function fitGhostText(value: string, availableCells: number) {
  const width = textCellWidth(value);
  if (width <= availableCells)
    return { text: value, width: Math.max(1, width) };
  if (availableCells <= 3) {
    const text = ".".repeat(availableCells);
    return { text, width: availableCells };
  }
  const prefix = takeCells(value, availableCells - 3);
  return { text: `${prefix.text}...`, width: prefix.width + 3 };
}
