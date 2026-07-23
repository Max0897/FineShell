import { describe, expect, test } from "bun:test";
import {
  DEFAULT_APP_SETTINGS,
  appSettingsEqual,
  sanitizeAppSettings,
} from "./app-settings";

describe("app settings", () => {
  test("uses defaults for missing or unsupported values", () => {
    expect(
      sanitizeAppSettings({
        terminalFontFamily: "comic-sans",
        terminalCursorStyle: "circle",
      }),
    ).toEqual(DEFAULT_APP_SETTINGS);
  });

  test("bounds numeric values and preserves supported preferences", () => {
    const settings = sanitizeAppSettings({
      terminalFontFamily: "menlo",
      terminalFontSize: 99,
      terminalCursorStyle: "bar",
      terminalCursorBlink: false,
      terminalScrollback: 200,
      showHiddenFiles: false,
      confirmFileDelete: false,
      externalEditorPath: "  /Applications/Visual Studio Code.app  ",
      externalEditorName: "  Visual Studio Code  ",
      monitorRefreshIntervalSeconds: 1,
      defaultConnectTimeoutSeconds: 8,
      defaultKeepAliveIntervalSeconds: 30,
      defaultAutoReconnect: false,
      defaultMaxReconnectAttempts: 20,
    });

    expect(settings).toMatchObject({
      terminalFontFamily: "menlo",
      terminalFontSize: 24,
      terminalCursorStyle: "bar",
      terminalCursorBlink: false,
      terminalScrollback: 1_000,
      showHiddenFiles: false,
      confirmFileDelete: false,
      externalEditorPath: "/Applications/Visual Studio Code.app",
      externalEditorName: "Visual Studio Code",
      monitorRefreshIntervalSeconds: 3,
      defaultConnectTimeoutSeconds: 8,
      defaultKeepAliveIntervalSeconds: 30,
      defaultAutoReconnect: false,
      defaultMaxReconnectAttempts: 10,
    });
  });

  test("compares every persisted setting", () => {
    expect(appSettingsEqual(DEFAULT_APP_SETTINGS, DEFAULT_APP_SETTINGS)).toBe(
      true,
    );
    expect(
      appSettingsEqual(DEFAULT_APP_SETTINGS, {
        ...DEFAULT_APP_SETTINGS,
        terminalFontSize: 14,
      }),
    ).toBe(false);
  });
});
