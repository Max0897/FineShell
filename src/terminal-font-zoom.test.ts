import { describe, expect, test } from "bun:test";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  nextTerminalFontSizeOffset,
  terminalFontSize,
  terminalFontZoomKeyboardAction,
  terminalFontZoomWheelAction,
} from "./terminal-font-zoom";

describe("terminal font zoom", () => {
  test("clamps the temporary size without changing the configured base", () => {
    expect(terminalFontSize(13, 2)).toBe(15);
    expect(terminalFontSize(13, -99)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(13, 99)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(nextTerminalFontSizeOffset(13, 3, "reset")).toBe(0);
  });

  test("increments one pixel and remains inside the supported range", () => {
    expect(nextTerminalFontSizeOffset(13, 0, "increase")).toBe(1);
    expect(nextTerminalFontSizeOffset(13, 0, "decrease")).toBe(-1);
    expect(nextTerminalFontSizeOffset(24, 4, "increase")).toBe(4);
    expect(nextTerminalFontSizeOffset(10, -1, "decrease")).toBe(-1);
  });

  test("uses Command on Apple platforms and Ctrl elsewhere", () => {
    expect(
      terminalFontZoomKeyboardAction(
        { altKey: false, code: "Equal", ctrlKey: false, metaKey: true },
        "MacIntel",
      ),
    ).toBe("increase");
    expect(
      terminalFontZoomKeyboardAction(
        { altKey: false, code: "Minus", ctrlKey: true, metaKey: false },
        "Win32",
      ),
    ).toBe("decrease");
    expect(
      terminalFontZoomKeyboardAction(
        { altKey: false, code: "Digit0", ctrlKey: true, metaKey: false },
        "Linux x86_64",
      ),
    ).toBe("reset");
    expect(
      terminalFontZoomKeyboardAction(
        { altKey: false, code: "Equal", ctrlKey: true, metaKey: false },
        "MacIntel",
      ),
    ).toBeUndefined();
    expect(
      terminalFontZoomKeyboardAction(
        {
          altKey: false,
          code: "Equal",
          ctrlKey: false,
          metaKey: true,
          type: "keyup",
        },
        "MacIntel",
      ),
    ).toBeUndefined();
  });

  test("maps primary-modifier wheel direction to zoom actions", () => {
    expect(
      terminalFontZoomWheelAction(
        { altKey: false, ctrlKey: false, deltaY: -10, metaKey: true },
        "MacIntel",
      ),
    ).toBe("increase");
    expect(
      terminalFontZoomWheelAction(
        { altKey: false, ctrlKey: true, deltaY: 10, metaKey: false },
        "Win32",
      ),
    ).toBe("decrease");
    expect(
      terminalFontZoomWheelAction(
        { altKey: false, ctrlKey: false, deltaY: 10, metaKey: false },
        "Win32",
      ),
    ).toBeUndefined();
  });
});
