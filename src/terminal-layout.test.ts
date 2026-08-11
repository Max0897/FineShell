import { describe, expect, test } from "bun:test";
import { balancedTerminalGridTopInset } from "./terminal-layout";

describe("terminal grid layout", () => {
  test("balances unused row space between the top and bottom", () => {
    expect(
      balancedTerminalGridTopInset({
        containerHeight: 720,
        paddingBottom: 4,
        paddingTop: 8,
        screenHeight: 672,
      }),
    ).toBe(16);
  });

  test("keeps the default top inset when the remaining space is small", () => {
    expect(
      balancedTerminalGridTopInset({
        containerHeight: 700,
        paddingBottom: 4,
        paddingTop: 8,
        screenHeight: 687,
      }),
    ).toBe(0);
  });

  test("never returns an inset outside the available remaining space", () => {
    expect(
      balancedTerminalGridTopInset({
        containerHeight: 100,
        paddingBottom: 20,
        paddingTop: 0,
        screenHeight: 70,
      }),
    ).toBe(10);
  });
});
