import { isApplePlatform } from "./platform-utils";

export type TerminalFontZoomAction = "decrease" | "increase" | "reset";

export const MIN_TERMINAL_FONT_SIZE = 9;
export const MAX_TERMINAL_FONT_SIZE = 28;

interface PrimaryModifierEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface TerminalFontZoomKeyboardEvent extends PrimaryModifierEvent {
  code: string;
  type?: string;
}

interface TerminalFontZoomWheelEvent extends PrimaryModifierEvent {
  deltaY: number;
}

function hasPrimaryModifier(event: PrimaryModifierEvent, platform: string) {
  return isApplePlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function terminalFontSize(baseSize: number, offset: number) {
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(baseSize + offset)),
  );
}

export function nextTerminalFontSizeOffset(
  baseSize: number,
  currentOffset: number,
  action: TerminalFontZoomAction,
) {
  if (action === "reset") return 0;
  const currentSize = terminalFontSize(baseSize, currentOffset);
  const delta = action === "increase" ? 1 : -1;
  return terminalFontSize(currentSize, delta) - baseSize;
}

export function terminalFontZoomKeyboardAction(
  event: TerminalFontZoomKeyboardEvent,
  platform: string = navigator.platform,
): TerminalFontZoomAction | undefined {
  if (
    (event.type && event.type !== "keydown") ||
    event.altKey ||
    !hasPrimaryModifier(event, platform)
  ) {
    return undefined;
  }
  if (event.code === "Equal" || event.code === "NumpadAdd") return "increase";
  if (event.code === "Minus" || event.code === "NumpadSubtract") {
    return "decrease";
  }
  if (event.code === "Digit0" || event.code === "Numpad0") return "reset";
  return undefined;
}

export function terminalFontZoomWheelAction(
  event: TerminalFontZoomWheelEvent,
  platform: string = navigator.platform,
): TerminalFontZoomAction | undefined {
  if (
    event.altKey ||
    !hasPrimaryModifier(event, platform) ||
    event.deltaY === 0
  ) {
    return undefined;
  }
  return event.deltaY < 0 ? "increase" : "decrease";
}
