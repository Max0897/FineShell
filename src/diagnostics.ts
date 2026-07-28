import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import type { DiagnosticLogLevel } from "./app-settings";
import {
  commandErrorMessage,
  FineShellCommandError,
  invokeProtocolCommand,
  type TauriCommand,
} from "./tauri-protocol";

export type { DiagnosticLogLevel } from "./app-settings";

interface DiagnosticRecordInput {
  context?: unknown;
  level: DiagnosticLogLevel;
  message: string;
  scope: string;
}

const HIGH_FREQUENCY_COMMANDS = new Set<TauriCommand>([
  "ssh_monitor_snapshot",
  "ssh_resize",
  "ssh_write",
]);
const LEVEL_RANK: Record<DiagnosticLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const SENSITIVE_KEY =
  /(address|args?|command|contents?|data|host(name)?|password|passphrase|path|private.?key|request|secret|target|token|username)/i;

let configuredLevel: DiagnosticLogLevel = "info";

function redactText(value: string) {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      "[PRIVATE_KEY]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[CREDENTIALS]@")
    .replace(/\b[a-z_][\w.-]*@(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[USER]@[HOST]")
    .replace(
      /\b[a-z_][\w.-]*@(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])/gi,
      "[USER]@[HOST]",
    )
    .replace(
      /(password|passphrase|api[_-]?key|token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[HOST]")
    .replace(/\[[0-9a-f:]*:[0-9a-f:]*\]/gi, "[HOST]")
    .replace(
      /(^|[^0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}($|[^0-9a-f:])/gi,
      "$1[HOST]$2",
    )
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[HOST]")
    .replace(/(^|[\s(])\/(?:[^\s):]+\/?)+/g, "$1[PATH]")
    .replace(/\b[a-z]:\\[^\s]+/gi, "[PATH]");
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeDiagnosticValue(item),
    ]),
  );
}

function sanitizeRecord(input: DiagnosticRecordInput): DiagnosticRecordInput {
  return {
    level: input.level,
    scope:
      input.scope
        .trim()
        .replace(/[^a-z0-9._:-]+/gi, "_")
        .slice(0, 80) || "application",
    message: redactText(input.message).slice(0, 2_000),
    context: sanitizeDiagnosticValue(input.context),
  };
}

export async function configureDiagnosticLogging(level: DiagnosticLogLevel) {
  configuredLevel = level;
  if (!isTauri()) return;
  await tauriInvoke("diagnostic_set_level", { level });
}

export function recordDiagnostic(
  level: DiagnosticLogLevel,
  scope: string,
  message: string,
  context?: unknown,
) {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel]) return;
  const entry = sanitizeRecord({ context, level, message, scope });
  if (!isTauri()) return;
  void tauriInvoke("diagnostic_record", { entry }).catch(() => undefined);
}

export async function diagnosticInvoke<T>(
  command: TauriCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();
  const recordLifecycle = !HIGH_FREQUENCY_COMMANDS.has(command);
  if (recordLifecycle) {
    recordDiagnostic("debug", "tauri.command", "开始调用桌面命令", {
      operation: command,
    });
  }
  try {
    const result = await invokeProtocolCommand<T>(command, args);
    if (recordLifecycle) {
      recordDiagnostic("debug", "tauri.command", "桌面命令调用完成", {
        durationMs: Math.round(performance.now() - startedAt),
        operation: command,
      });
    }
    return result;
  } catch (error) {
    recordDiagnostic("error", "tauri.command", "桌面命令调用失败", {
      error:
        error instanceof FineShellCommandError
          ? error.toJSON()
          : commandErrorMessage(error),
      operation: command,
    });
    throw error;
  }
}

export async function openDiagnosticLog() {
  if (!isTauri()) throw new Error("打开诊断日志仅支持桌面应用");
  await tauriInvoke("diagnostic_open_log");
}

export async function openDiagnosticLogDirectory() {
  if (!isTauri()) throw new Error("打开诊断日志目录仅支持桌面应用");
  await tauriInvoke("diagnostic_open_log_directory");
}

export function installGlobalDiagnostics() {
  const onError = (event: ErrorEvent) => {
    recordDiagnostic("error", "frontend.runtime", "前端运行时异常", {
      error: event.error instanceof Error ? event.error.message : event.message,
      sourcePath: event.filename,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordDiagnostic("error", "frontend.promise", "未处理的异步异常", {
      error: String(event.reason),
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  recordDiagnostic("info", "application", "应用界面已初始化");
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
