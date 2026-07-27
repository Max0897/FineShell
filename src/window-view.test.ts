import { describe, expect, test } from "bun:test";
import {
  auxiliaryWindowHref,
  windowViewFromContext,
  windowViewFromLocation,
  windowViewFromWindowLabel,
} from "./window-view";

describe("window view routing", () => {
  test("reads auxiliary views from URL fragments", () => {
    expect(windowViewFromLocation({ hash: "#view=settings", search: "" })).toBe(
      "settings",
    );
    expect(
      windowViewFromLocation({ hash: "#view=shortcuts", search: "" }),
    ).toBe("shortcuts");
  });

  test("keeps query parameters compatible for browser previews", () => {
    expect(windowViewFromLocation({ hash: "", search: "?view=settings" })).toBe(
      "settings",
    );
  });

  test("ignores unsupported views", () => {
    expect(windowViewFromLocation({ hash: "#view=unknown", search: "" })).toBe(
      null,
    );
  });

  test("builds fragment-only auxiliary window links", () => {
    expect(auxiliaryWindowHref("settings")).toBe("#view=settings");
    expect(auxiliaryWindowHref("shortcuts")).toBe("#view=shortcuts");
  });

  test("falls back to the native window label", () => {
    expect(windowViewFromWindowLabel("settings")).toBe("settings");
    expect(windowViewFromWindowLabel("shortcut-guide")).toBe("shortcuts");
    expect(windowViewFromWindowLabel("main")).toBe(null);
  });

  test("prefers the native window label over location hints", () => {
    expect(
      windowViewFromContext({
        location: { hash: "#view=shortcuts", search: "" },
        windowLabel: "settings",
      }),
    ).toBe("settings");
  });
});
