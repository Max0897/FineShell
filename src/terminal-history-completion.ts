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
  ghostTextColor?: string;
}

export class TerminalHistoryCompletionAddon implements ITerminalAddon {
  private terminal?: Terminal;
  private history: readonly TerminalCommandHistoryRecord[] = [];
  private commandLine = "";
  private inputReliable = true;
  private promptReady = false;
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
      terminal.onWriteParsed(() => this.refreshDecoration()),
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
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.terminal = undefined;
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
