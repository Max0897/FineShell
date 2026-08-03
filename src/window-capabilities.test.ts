import { describe, expect, test } from "bun:test";
import defaultCapability from "../src-tauri/capabilities/default.json";
import updaterCapability from "../src-tauri/capabilities/updater.json";

describe("window capabilities", () => {
  test("keeps auxiliary windows reusable", () => {
    expect(defaultCapability.windows).toEqual(
      expect.arrayContaining(["main", "settings", "shortcut-guide"]),
    );
    expect(defaultCapability.permissions).not.toContain(
      "core:window:allow-destroy",
    );
    expect(defaultCapability.permissions).toContain(
      "core:window:allow-set-size",
    );
    expect(defaultCapability.permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-request-user-attention",
        "core:window:allow-set-focus",
        "core:window:allow-show",
        "core:window:allow-unminimize",
      ]),
    );
  });

  test("allows update checks from both application entry points", () => {
    expect(updaterCapability.windows).toEqual(
      expect.arrayContaining(["main", "settings"]),
    );
    expect(updaterCapability.permissions).toEqual(
      expect.arrayContaining(["updater:default", "process:allow-restart"]),
    );
  });
});
