export type TerminalFontFamily = "system" | "menlo" | "consolas";
export type TerminalCursorStyle = "block" | "underline" | "bar";

export interface AppSettings {
  terminalFontFamily: TerminalFontFamily;
  terminalFontSize: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  showHiddenFiles: boolean;
  confirmFileDelete: boolean;
  monitorRefreshIntervalSeconds: number;
  defaultConnectTimeoutSeconds: number;
  defaultKeepAliveIntervalSeconds: number;
  defaultAutoReconnect: boolean;
  defaultMaxReconnectAttempts: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminalFontFamily: "system",
  terminalFontSize: 13,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalScrollback: 5_000,
  showHiddenFiles: true,
  confirmFileDelete: true,
  monitorRefreshIntervalSeconds: 5,
  defaultConnectTimeoutSeconds: 10,
  defaultKeepAliveIntervalSeconds: 15,
  defaultAutoReconnect: true,
  defaultMaxReconnectAttempts: 3,
};

export const TERMINAL_FONT_FAMILIES: Record<TerminalFontFamily, string> = {
  system: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Monaco, "Liberation Mono", monospace',
  consolas: 'Consolas, "Liberation Mono", monospace',
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  const settings = isRecord(value) ? value : {};
  return {
    terminalFontFamily:
      settings.terminalFontFamily === "menlo" ||
      settings.terminalFontFamily === "consolas"
        ? settings.terminalFontFamily
        : DEFAULT_APP_SETTINGS.terminalFontFamily,
    terminalFontSize: numberValue(
      settings.terminalFontSize,
      DEFAULT_APP_SETTINGS.terminalFontSize,
      10,
      24,
    ),
    terminalCursorStyle:
      settings.terminalCursorStyle === "underline" ||
      settings.terminalCursorStyle === "bar"
        ? settings.terminalCursorStyle
        : DEFAULT_APP_SETTINGS.terminalCursorStyle,
    terminalCursorBlink: booleanValue(
      settings.terminalCursorBlink,
      DEFAULT_APP_SETTINGS.terminalCursorBlink,
    ),
    terminalScrollback: numberValue(
      settings.terminalScrollback,
      DEFAULT_APP_SETTINGS.terminalScrollback,
      1_000,
      100_000,
    ),
    showHiddenFiles: booleanValue(
      settings.showHiddenFiles,
      DEFAULT_APP_SETTINGS.showHiddenFiles,
    ),
    confirmFileDelete: booleanValue(
      settings.confirmFileDelete,
      DEFAULT_APP_SETTINGS.confirmFileDelete,
    ),
    monitorRefreshIntervalSeconds: numberValue(
      settings.monitorRefreshIntervalSeconds,
      DEFAULT_APP_SETTINGS.monitorRefreshIntervalSeconds,
      3,
      30,
    ),
    defaultConnectTimeoutSeconds: numberValue(
      settings.defaultConnectTimeoutSeconds,
      DEFAULT_APP_SETTINGS.defaultConnectTimeoutSeconds,
      3,
      120,
    ),
    defaultKeepAliveIntervalSeconds: numberValue(
      settings.defaultKeepAliveIntervalSeconds,
      DEFAULT_APP_SETTINGS.defaultKeepAliveIntervalSeconds,
      5,
      300,
    ),
    defaultAutoReconnect: booleanValue(
      settings.defaultAutoReconnect,
      DEFAULT_APP_SETTINGS.defaultAutoReconnect,
    ),
    defaultMaxReconnectAttempts: numberValue(
      settings.defaultMaxReconnectAttempts,
      DEFAULT_APP_SETTINGS.defaultMaxReconnectAttempts,
      1,
      10,
    ),
  };
}

export function appSettingsEqual(left: AppSettings, right: AppSettings) {
  return (Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[]).every(
    (key) => left[key] === right[key],
  );
}
