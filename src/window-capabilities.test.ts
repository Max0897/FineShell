import { describe, expect, test } from "bun:test";
import defaultCapability from "../src-tauri/capabilities/default.json";
import updaterCapability from "../src-tauri/capabilities/updater.json";
import linuxConfig from "../src-tauri/tauri.linux.conf.json";
import macosConfig from "../src-tauri/tauri.macos.conf.json";
import windowsConfig from "../src-tauri/tauri.windows.conf.json";

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
        "core:window:allow-close",
        "core:window:allow-is-maximized",
        "core:window:allow-minimize",
        "core:window:allow-request-user-attention",
        "core:window:allow-set-focus",
        "core:window:allow-show",
        "core:window:allow-start-dragging",
        "core:window:allow-toggle-maximize",
        "core:window:allow-unminimize",
      ]),
    );
  });

  test("uses native macOS controls and custom Windows/Linux controls", () => {
    const macosMainWindow = macosConfig.app.windows.find(
      (window) => window.label === "main",
    );
    const windowsMainWindow = windowsConfig.app.windows.find(
      (window) => window.label === "main",
    );
    const windowsSettingsWindow = windowsConfig.app.windows.find(
      (window) => window.label === "settings",
    );
    const linuxMainWindow = linuxConfig.app.windows.find(
      (window) => window.label === "main",
    );

    expect(macosMainWindow).toMatchObject({
      decorations: true,
      hiddenTitle: true,
      titleBarStyle: "Overlay",
    });
    expect(windowsMainWindow).toMatchObject({ decorations: false });
    expect(windowsSettingsWindow).not.toHaveProperty("decorations", false);
    expect(linuxMainWindow).toMatchObject({ decorations: false });
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
