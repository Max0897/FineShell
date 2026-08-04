import type { TerminalCommandHistoryRecord } from "./models";

export const MAX_TERMINAL_COMMAND_HISTORY_PER_HOST = 500;
export const MAX_TERMINAL_COMMAND_HISTORY_TOTAL = 5_000;
export const MAX_TERMINAL_COMMAND_CHARS = 4_096;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validDate(value: unknown) {
  const date = nonEmptyString(value);
  return date && Number.isFinite(Date.parse(date)) ? date : undefined;
}

export function sanitizeTerminalCommandHistoryRecord(
  value: unknown,
): TerminalCommandHistoryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const hostId = nonEmptyString(value.hostId);
  const command = nonEmptyString(value.command);
  const lastUsedAt = validDate(value.lastUsedAt);
  if (
    !id ||
    !hostId ||
    !command ||
    !lastUsedAt ||
    command.length > MAX_TERMINAL_COMMAND_CHARS ||
    /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(command)
  ) {
    return undefined;
  }
  const cwd = nonEmptyString(value.cwd);
  const useCount =
    typeof value.useCount === "number" &&
    Number.isSafeInteger(value.useCount) &&
    value.useCount > 0
      ? Math.min(value.useCount, Number.MAX_SAFE_INTEGER)
      : 1;
  return {
    id,
    hostId,
    command,
    ...(cwd && cwd.startsWith("/") && cwd.length <= 4_096 ? { cwd } : {}),
    lastUsedAt,
    useCount,
  };
}

export function applyTerminalCommandHistoryPolicy(
  records: readonly TerminalCommandHistoryRecord[],
) {
  const unique = new Map<string, TerminalCommandHistoryRecord>();
  const perHost = new Map<string, number>();
  const sorted = [...records]
    .map(sanitizeTerminalCommandHistoryRecord)
    .filter((record): record is TerminalCommandHistoryRecord => Boolean(record))
    .sort(
      (left, right) =>
        Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt),
    );

  for (const record of sorted) {
    const key = `${record.hostId}\u0000${record.command}`;
    if (unique.has(key)) continue;
    const hostCount = perHost.get(record.hostId) ?? 0;
    if (hostCount >= MAX_TERMINAL_COMMAND_HISTORY_PER_HOST) continue;
    unique.set(key, record);
    perHost.set(record.hostId, hostCount + 1);
    if (unique.size >= MAX_TERMINAL_COMMAND_HISTORY_TOTAL) break;
  }
  return [...unique.values()];
}

export function recordTerminalCommand(
  records: readonly TerminalCommandHistoryRecord[],
  input: { hostId: string; command: string; cwd?: string },
  now = new Date(),
) {
  const hostId = input.hostId.trim();
  const command = input.command.trim();
  if (
    !hostId ||
    !command ||
    command.length > MAX_TERMINAL_COMMAND_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(command)
  ) {
    return applyTerminalCommandHistoryPolicy(records);
  }

  const existing = records.find(
    (record) => record.hostId === hostId && record.command === command,
  );
  const next: TerminalCommandHistoryRecord = {
    id:
      existing?.id ??
      `terminal-history-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    hostId,
    command,
    ...(input.cwd?.startsWith("/") ? { cwd: input.cwd.slice(0, 4_096) } : {}),
    lastUsedAt: now.toISOString(),
    useCount: Math.min((existing?.useCount ?? 0) + 1, Number.MAX_SAFE_INTEGER),
  };
  return applyTerminalCommandHistoryPolicy([
    next,
    ...records.filter((record) => record.id !== existing?.id),
  ]);
}

export function findTerminalHistoryCompletion(
  records: readonly TerminalCommandHistoryRecord[],
  input: { hostId: string; commandLine: string; cwd?: string },
) {
  if (input.commandLine.trim().length < 2) return undefined;
  const candidates = records.filter(
    (record) =>
      record.hostId === input.hostId &&
      record.command !== input.commandLine &&
      record.command.startsWith(input.commandLine),
  );
  candidates.sort((left, right) => {
    const leftDirectory = input.cwd && left.cwd === input.cwd ? 1 : 0;
    const rightDirectory = input.cwd && right.cwd === input.cwd ? 1 : 0;
    if (leftDirectory !== rightDirectory) return rightDirectory - leftDirectory;
    if (left.useCount !== right.useCount) return right.useCount - left.useCount;
    return Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt);
  });
  const command = candidates[0]?.command;
  return command
    ? { command, suffix: command.slice(input.commandLine.length) }
    : undefined;
}
