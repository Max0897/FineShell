import { describe, expect, test } from "bun:test";
import {
  AI_SIDEBAR_DEFAULT_WIDTH,
  aiWindowTargetWidth,
  clampAiSidebarWidth,
} from "./ai-sidebar";

describe("AI sidebar layout", () => {
  test("opens by adding the default sidebar width and restores it once", () => {
    const expanded = aiWindowTargetWidth(1_280, true, 0);
    expect(expanded).toBe(1_280 + AI_SIDEBAR_DEFAULT_WIDTH);
    expect(
      aiWindowTargetWidth(expanded, false, AI_SIDEBAR_DEFAULT_WIDTH),
    ).toBe(1_280);
  });

  test("bounds manual sidebar resizing and protects the main window minimum", () => {
    expect(clampAiSidebarWidth(200)).toBe(360);
    expect(clampAiSidebarWidth(500)).toBe(500);
    expect(clampAiSidebarWidth(900)).toBe(640);
    expect(clampAiSidebarWidth(640, 1_160)).toBe(440);
    expect(clampAiSidebarWidth(640, 1_360)).toBe(640);
    expect(aiWindowTargetWidth(800, false, 440)).toBe(720);
  });
});
