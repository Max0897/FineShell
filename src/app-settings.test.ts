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
      appearanceMode: "dark",
      terminalColorScheme: "solarizedDark",
      terminalFontFamily: "menlo",
      terminalFontSize: 99,
      terminalLineHeight: 9,
      terminalCursorStyle: "bar",
      terminalCursorBlink: false,
      terminalScrollback: 200,
      terminalCopyOnSelect: true,
      terminalRightClickAction: "paste",
      showHiddenFiles: false,
      confirmFileDelete: false,
      externalEditorPath: "  /Applications/Visual Studio Code.app  ",
      externalEditorName: "  Visual Studio Code  ",
      monitorRefreshIntervalSeconds: 1,
      defaultConnectTimeoutSeconds: 8,
      defaultKeepAliveIntervalSeconds: 30,
      defaultAutoReconnect: false,
      defaultMaxReconnectAttempts: 20,
      connectionHistoryLimit: 100,
      connectionHistoryRetentionDays: 30,
      diagnosticLogLevel: "debug",
      githubMirrorRoute: "custom",
      githubMirrorCustomUrl: "  https://mirror.example.com/github/  ",
      aiProvider: "deepseek",
      aiBaseUrl: "  https://example.com/v1  ",
      aiModel: "  model-name  ",
      aiContextMaxChars: 99_000,
      aiToolsEnabled: false,
      aiFileProposalsEnabled: false,
      aiCommandProposalsEnabled: false,
      aiCommandTrackingEnabled: false,
    });

    expect(settings).toMatchObject({
      appearanceMode: "dark",
      terminalColorScheme: "solarizedDark",
      terminalFontFamily: "menlo",
      terminalFontSize: 24,
      terminalLineHeight: 2,
      terminalCursorStyle: "bar",
      terminalCursorBlink: false,
      terminalScrollback: 1_000,
      terminalCopyOnSelect: true,
      terminalRightClickAction: "paste",
      showHiddenFiles: false,
      confirmFileDelete: false,
      externalEditorPath: "/Applications/Visual Studio Code.app",
      externalEditorName: "Visual Studio Code",
      monitorRefreshIntervalSeconds: 3,
      defaultConnectTimeoutSeconds: 8,
      defaultKeepAliveIntervalSeconds: 30,
      defaultAutoReconnect: false,
      defaultMaxReconnectAttempts: 10,
      connectionHistoryLimit: 100,
      connectionHistoryRetentionDays: 30,
      diagnosticLogLevel: "debug",
      githubMirrorRoute: "custom",
      githubMirrorCustomUrl: "https://mirror.example.com/github/",
      aiProvider: "deepseek",
      aiBaseUrl: "https://example.com/v1",
      aiModel: "model-name",
      aiContextMaxChars: 32_000,
      aiReadOnlyTools: [],
      aiFileProposalsEnabled: false,
      aiCommandProposalsEnabled: false,
      aiCommandTrackingEnabled: false,
    });
  });

  test("infers an AI provider for settings saved before provider presets", () => {
    expect(
      sanitizeAppSettings({ aiBaseUrl: "http://localhost:11434/v1/" })
        .aiProvider,
    ).toBe("ollama");
    expect(
      sanitizeAppSettings({ aiBaseUrl: "https://llm.example.com/v1" })
        .aiProvider,
    ).toBe("custom");
  });

  test("sanitizes fine-grained AI permissions", () => {
    const settings = sanitizeAppSettings({
      aiReadOnlyTools: ["list_processes", "unknown", "list_processes"],
    });
    expect(settings.aiReadOnlyTools).toEqual(["list_processes"]);
  });

  test("falls back to automatic GitHub routing for unsupported values", () => {
    const settings = sanitizeAppSettings({
      githubMirrorRoute: "unknown",
      githubMirrorCustomUrl: " x".repeat(600),
    });
    expect(settings.githubMirrorRoute).toBe("auto");
    expect(settings.githubMirrorCustomUrl.length).toBe(512);
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
    expect(
      appSettingsEqual(DEFAULT_APP_SETTINGS, {
        ...DEFAULT_APP_SETTINGS,
        aiReadOnlyTools: ["get_server_status"],
      }),
    ).toBe(false);
  });
});
