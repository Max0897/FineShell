import { describe, expect, test } from "bun:test";
import { auxiliaryWindowHref, windowViewFromLocation } from "./window-view";

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
});
