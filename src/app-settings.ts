import { inferAiProvider, type AiProvider } from "./ai-providers";
import {
  ALL_AI_READ_ONLY_TOOLS,
  sanitizeAiReadOnlyTools,
  type AiReadOnlyToolName,
} from "./ai-permissions";

export type { AiProvider } from "./ai-providers";

export type TerminalFontFamily = "system" | "menlo" | "consolas";
export type TerminalCursorStyle = "block" | "underline" | "bar";
export type TerminalColorScheme =
  "fineshellDark" | "graphiteLight" | "solarizedDark" | "dracula";
export type TerminalRightClickAction = "menu" | "paste";
export type ConnectionHistoryLimit = 0 | 20 | 50 | 100;
export type ConnectionHistoryRetentionDays = 0 | 7 | 30 | 90;
export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";
export type GithubMirrorRoute =
  | "auto"
  | "direct"
  | "gh-proxy.com"
  | "ghproxy.net"
  | "custom";

export interface AppSettings {
  terminalColorScheme: TerminalColorScheme;
  terminalFontFamily: TerminalFontFamily;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalCopyOnSelect: boolean;
  terminalRightClickAction: TerminalRightClickAction;
  showHiddenFiles: boolean;
  confirmFileDelete: boolean;
  externalEditorPath: string;
  externalEditorName: string;
  monitorRefreshIntervalSeconds: number;
  defaultConnectTimeoutSeconds: number;
  defaultKeepAliveIntervalSeconds: number;
  defaultAutoReconnect: boolean;
  defaultMaxReconnectAttempts: number;
  connectionHistoryLimit: ConnectionHistoryLimit;
  connectionHistoryRetentionDays: ConnectionHistoryRetentionDays;
  diagnosticLogLevel: DiagnosticLogLevel;
  githubMirrorRoute: GithubMirrorRoute;
  githubMirrorCustomUrl: string;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiModel: string;
  aiContextMaxChars: number;
  aiReadOnlyTools: AiReadOnlyToolName[];
  aiFileProposalsEnabled: boolean;
  aiCommandProposalsEnabled: boolean;
  aiCommandTrackingEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminalColorScheme: "fineshellDark",
  terminalFontFamily: "system",
  terminalFontSize: 13,
  terminalLineHeight: 1.2,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalScrollback: 5_000,
  terminalCopyOnSelect: false,
  terminalRightClickAction: "menu",
  showHiddenFiles: true,
  confirmFileDelete: true,
  externalEditorPath: "",
  externalEditorName: "",
  monitorRefreshIntervalSeconds: 5,
  defaultConnectTimeoutSeconds: 10,
  defaultKeepAliveIntervalSeconds: 15,
  defaultAutoReconnect: true,
  defaultMaxReconnectAttempts: 3,
  connectionHistoryLimit: 50,
  connectionHistoryRetentionDays: 0,
  diagnosticLogLevel: "info",
  githubMirrorRoute: "auto",
  githubMirrorCustomUrl: "",
  aiProvider: "openai",
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "",
  aiContextMaxChars: 12_000,
  aiReadOnlyTools: [...ALL_AI_READ_ONLY_TOOLS],
  aiFileProposalsEnabled: true,
  aiCommandProposalsEnabled: true,
  aiCommandTrackingEnabled: true,
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

function decimalValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function connectionHistoryLimitValue(value: unknown): ConnectionHistoryLimit {
  return value === 0 || value === 20 || value === 100 ? value : 50;
}

function connectionHistoryRetentionDaysValue(
  value: unknown,
): ConnectionHistoryRetentionDays {
  return value === 7 || value === 30 || value === 90 ? value : 0;
}

function aiProviderValue(value: unknown, baseUrl: string): AiProvider {
  return value === "openai" ||
    value === "deepseek" ||
    value === "ollama" ||
    value === "custom"
    ? value
    : inferAiProvider(baseUrl);
}

function githubMirrorRouteValue(value: unknown): GithubMirrorRoute {
  return value === "direct" ||
    value === "gh-proxy.com" ||
    value === "ghproxy.net" ||
    value === "custom"
    ? value
    : "auto";
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  const settings = isRecord(value) ? value : {};
  const aiBaseUrl =
    stringValue(settings.aiBaseUrl) || DEFAULT_APP_SETTINGS.aiBaseUrl;
  return {
    terminalColorScheme:
      settings.terminalColorScheme === "graphiteLight" ||
      settings.terminalColorScheme === "solarizedDark" ||
      settings.terminalColorScheme === "dracula"
        ? settings.terminalColorScheme
        : DEFAULT_APP_SETTINGS.terminalColorScheme,
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
    terminalLineHeight: decimalValue(
      settings.terminalLineHeight,
      DEFAULT_APP_SETTINGS.terminalLineHeight,
      1,
      2,
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
    terminalCopyOnSelect: booleanValue(
      settings.terminalCopyOnSelect,
      DEFAULT_APP_SETTINGS.terminalCopyOnSelect,
    ),
    terminalRightClickAction:
      settings.terminalRightClickAction === "paste"
        ? "paste"
        : DEFAULT_APP_SETTINGS.terminalRightClickAction,
    showHiddenFiles: booleanValue(
      settings.showHiddenFiles,
      DEFAULT_APP_SETTINGS.showHiddenFiles,
    ),
    confirmFileDelete: booleanValue(
      settings.confirmFileDelete,
      DEFAULT_APP_SETTINGS.confirmFileDelete,
    ),
    externalEditorPath: stringValue(settings.externalEditorPath),
    externalEditorName: stringValue(settings.externalEditorName),
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
    connectionHistoryLimit: connectionHistoryLimitValue(
      settings.connectionHistoryLimit,
    ),
    connectionHistoryRetentionDays: connectionHistoryRetentionDaysValue(
      settings.connectionHistoryRetentionDays,
    ),
    diagnosticLogLevel:
      settings.diagnosticLogLevel === "debug" ||
      settings.diagnosticLogLevel === "warn" ||
      settings.diagnosticLogLevel === "error"
        ? settings.diagnosticLogLevel
        : DEFAULT_APP_SETTINGS.diagnosticLogLevel,
    githubMirrorRoute: githubMirrorRouteValue(settings.githubMirrorRoute),
    githubMirrorCustomUrl: stringValue(settings.githubMirrorCustomUrl).slice(
      0,
      512,
    ),
    aiProvider: aiProviderValue(settings.aiProvider, aiBaseUrl),
    aiBaseUrl,
    aiModel: stringValue(settings.aiModel).slice(0, 160),
    aiContextMaxChars: numberValue(
      settings.aiContextMaxChars,
      DEFAULT_APP_SETTINGS.aiContextMaxChars,
      2_000,
      32_000,
    ),
    aiReadOnlyTools: sanitizeAiReadOnlyTools(
      settings.aiReadOnlyTools,
      settings.aiToolsEnabled,
    ),
    aiFileProposalsEnabled: booleanValue(
      settings.aiFileProposalsEnabled,
      DEFAULT_APP_SETTINGS.aiFileProposalsEnabled,
    ),
    aiCommandProposalsEnabled: booleanValue(
      settings.aiCommandProposalsEnabled,
      DEFAULT_APP_SETTINGS.aiCommandProposalsEnabled,
    ),
    aiCommandTrackingEnabled: booleanValue(
      settings.aiCommandTrackingEnabled,
      DEFAULT_APP_SETTINGS.aiCommandTrackingEnabled,
    ),
  };
}

export function appSettingsEqual(left: AppSettings, right: AppSettings) {
  return (Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[]).every(
    (key) =>
      Array.isArray(left[key]) && Array.isArray(right[key])
        ? JSON.stringify(left[key]) === JSON.stringify(right[key])
        : left[key] === right[key],
  );
}
