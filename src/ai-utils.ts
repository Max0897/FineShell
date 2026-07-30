import type { ServerMonitorSnapshot } from "./models";

export function normalizeAiTerminalCommand(command: string) {
  const value = command.trim();
  if (!value || value.length > 4_096) {
    throw new Error("命令为空或内容过长");
  }
  if (/\r|\n|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error("为避免误执行，多行命令不能直接提交到终端");
  }
  return value;
}

export type AiContextSourceId =
  | "terminal-selection"
  | "terminal-output"
  | "server-monitor"
  | "process-selection"
  | "network-diagnostic"
  | "sftp-path"
  | "sftp-selection"
  | "sftp-file"
  | `sftp-file:${string}`
  | `terminal-command-result:${string}`;

export interface AiContextSource {
  content: string;
  id: AiContextSourceId;
  label: string;
  preserveWhitespace?: boolean;
  truncateFrom?: "start" | "end";
}

export interface AiContextPayloadResult {
  content: string;
  sourceChars: number;
  truncated: boolean;
  usedChars: number;
}

export interface AiRequestTokenBudget {
  contextChars: number;
  contextLimitChars: number;
  contextTokens: number;
  contextTruncated: boolean;
  contextUsagePercent: number;
  historyTokens: number;
  inputTokens: number;
  totalTokens: number;
}

export interface AiRemoteFileContext {
  content: string;
  name: string;
  path: string;
  size: number;
}

export const MAX_AI_REMOTE_FILE_BYTES = 256 * 1024;
export const MAX_AI_REMOTE_FILES = 8;
export const MAX_AI_REMOTE_FILES_BYTES = 512 * 1024;

export function aiRemoteFileContextSourceId(path: string) {
  return `sftp-file:${path}` as const;
}

export function isAiRemoteFileContextSourceId(id: AiContextSourceId) {
  return id === "sftp-file" || id.startsWith("sftp-file:");
}

export function aiRemoteFileContextError(size: number) {
  if (!Number.isFinite(size) || size < 0) return "无法确认远程文件大小";
  if (size > MAX_AI_REMOTE_FILE_BYTES) {
    return "远程文件超过 256 KiB，无法加入 AI 上下文";
  }
  return null;
}

export function aiRemoteFileContextSource(
  file: AiRemoteFileContext,
): AiContextSource {
  const trailingNewline = file.content.endsWith("\n");
  return {
    id: aiRemoteFileContextSourceId(file.path),
    label: `文件:${file.path}`,
    content: `远程路径: ${file.path}\n文件大小: ${file.size} B\n末尾换行: ${trailingNewline ? "是" : "否"}\n<file_content>\n${file.content}${trailingNewline ? "" : "\n"}</file_content>`,
    preserveWhitespace: true,
    truncateFrom: "start",
  };
}

export function mergeAiRemoteFileContexts(
  current: AiRemoteFileContext[],
  incoming: AiRemoteFileContext[],
) {
  const merged = new Map(current.map((file) => [file.path, file]));
  for (const file of incoming) merged.set(file.path, file);
  const files = Array.from(merged.values());
  if (files.length > MAX_AI_REMOTE_FILES) {
    throw new Error(`最多可同时添加 ${MAX_AI_REMOTE_FILES} 个远程文件`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_AI_REMOTE_FILES_BYTES) {
    throw new Error("远程文件上下文总大小不能超过 512 KiB");
  }
  return files;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aiContextMentionPattern(source: AiContextSource) {
  return new RegExp(
    `(^|\\s)@${escapeRegularExpression(source.label)}(?=\\s|$)`,
    "g",
  );
}

export function aiContextMentionIds(
  value: string,
  sources: AiContextSource[],
): AiContextSourceId[] {
  return sources
    .filter(
      (source) =>
        Boolean(source.content.trim()) &&
        aiContextMentionPattern(source).test(value),
    )
    .map((source) => source.id);
}

export function appendAiContextMentions(
  value: string,
  sources: AiContextSource[],
  selectedIds: AiContextSourceId[],
) {
  const selected = new Set(selectedIds);
  const existing = new Set(aiContextMentionIds(value, sources));
  const mentions = sources
    .filter(
      (source) =>
        selected.has(source.id) &&
        Boolean(source.content.trim()) &&
        !existing.has(source.id),
    )
    .map((source) => `@${source.label}`);
  if (!mentions.length) return value;
  const current = value.trimEnd();
  return `${current}${current ? "\n\n" : ""}${mentions.join(" ")}`;
}

export function separateAiContextMentions(
  value: string,
  sources: AiContextSource[],
) {
  const labels = [...new Set(sources.map((source) => source.label))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegularExpression);
  if (!labels.length) return value;
  return value.replace(
    new RegExp(`@(?:${labels.join("|")})(?=\\S|$)`, "g"),
    (mention) => `${mention} `,
  );
}

export function stripAiContextMentions(
  value: string,
  sources: AiContextSource[],
) {
  let result = value;
  for (const source of sources) {
    result = result.replace(aiContextMentionPattern(source), "$1");
  }
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface AiCommandAssessment {
  canInsert: boolean;
  label: string;
  reason?: string;
  risk: "safe" | "caution" | "danger";
}

export type AiCommandRisk = AiCommandAssessment["risk"];

const AI_COMMAND_RISK_LEVEL: Record<AiCommandRisk, number> = {
  safe: 0,
  caution: 1,
  danger: 2,
};

function aiCommandRiskLabel(risk: AiCommandRisk) {
  if (risk === "danger") return "高风险";
  if (risk === "caution") return "需确认";
  return "低风险";
}

export function combineAiTerminalCommandAssessment(
  command: string,
  aiRisk: AiCommandRisk,
  aiReason: string,
): AiCommandAssessment {
  const local = assessAiTerminalCommand(command);
  if (AI_COMMAND_RISK_LEVEL[local.risk] > AI_COMMAND_RISK_LEVEL[aiRisk]) {
    return local;
  }
  return {
    canInsert: local.canInsert,
    label: aiCommandRiskLabel(aiRisk),
    reason: aiReason,
    risk: aiRisk,
  };
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\b["']?(\s*[:=]\s*)["']?([^\s,"';&|}]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g;
const SECRET_ARGUMENT_PATTERN =
  /(^|[\s"'\\])(--?(?:password|passphrase|api[_-]?key|access[_-]?token|secret|token)\s+)["']?([^\s,"';&|}]+)/gi;
const CREDENTIAL_URL_PATTERN = /\b(https?:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;

export function redactAiContext(value: string) {
  return value
    .replace(PRIVATE_KEY_PATTERN, "[已隐藏私钥]")
    .replace(BEARER_PATTERN, "$1[已隐藏]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[已隐藏]")
    .replace(SECRET_ARGUMENT_PATTERN, "$1$2[已隐藏]")
    .replace(SECRET_TOKEN_PATTERN, "[已隐藏密钥]")
    .replace(CREDENTIAL_URL_PATTERN, "$1[已隐藏]$3");
}

export function buildAiContextPayloadResult(
  sources: AiContextSource[],
  selectedIds: AiContextSourceId[],
  maxChars: number,
): AiContextPayloadResult {
  const selected = new Set(selectedIds);
  const limit = Math.max(0, maxChars);
  if (!limit) {
    return { content: "", sourceChars: 0, truncated: false, usedChars: 0 };
  }
  const entries = sources
    .filter((source) => selected.has(source.id) && source.content.trim())
    .map((source) => ({
      content: redactAiContext(
        source.preserveWhitespace ? source.content : source.content.trim(),
      ),
      heading: `## ${source.label}\n`,
      truncateFrom: source.truncateFrom ?? "end",
    }));
  if (!entries.length) {
    return { content: "", sourceChars: 0, truncated: false, usedChars: 0 };
  }

  const overhead =
    entries.reduce((total, entry) => total + entry.heading.length, 0) +
    Math.max(0, entries.length - 1) * 2;
  const sourceChars =
    overhead +
    entries.reduce((total, entry) => total + entry.content.length, 0);
  if (overhead >= limit) {
    return { content: "", sourceChars, truncated: true, usedChars: 0 };
  }

  const allocations = entries.map(() => 0);
  let remaining = limit - overhead;
  let pending = entries.map((_, index) => index);
  while (pending.length && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    const completed = pending.filter(
      (index) => entries[index]!.content.length <= share,
    );
    if (!completed.length) {
      pending.forEach((index, offset) => {
        allocations[index] =
          share + (offset < remaining % pending.length ? 1 : 0);
      });
      break;
    }
    for (const index of completed) {
      allocations[index] = entries[index]!.content.length;
      remaining -= allocations[index]!;
    }
    const completedSet = new Set(completed);
    pending = pending.filter((index) => !completedSet.has(index));
  }

  const content = entries
    .map(
      (entry, index) =>
        `${entry.heading}${
          entry.truncateFrom === "start"
            ? entry.content.slice(0, allocations[index]!)
            : entry.content.slice(-allocations[index]!)
        }`,
    )
    .join("\n\n");
  return {
    content,
    sourceChars,
    truncated: sourceChars > content.length,
    usedChars: content.length,
  };
}

export function buildAiContextPayload(
  sources: AiContextSource[],
  selectedIds: AiContextSourceId[],
  maxChars: number,
) {
  return buildAiContextPayloadResult(sources, selectedIds, maxChars).content;
}

export function estimateAiTokenCount(value: string) {
  if (!value.trim()) return 0;
  let tokens = 0;
  for (const match of value.matchAll(/[\p{L}\p{N}_]+|[^\s]/gu)) {
    const segment = match[0];
    tokens += /^[A-Za-z0-9_]+$/.test(segment)
      ? Math.ceil(segment.length / 4)
      : Array.from(segment).length;
  }
  tokens += (value.match(/\n/g) ?? []).length;
  return Math.max(1, tokens);
}

export function estimateAiRequestTokenBudget(
  history: AiHistoryMessage[],
  input: string,
  context: AiContextPayloadResult,
  contextLimitChars: number,
): AiRequestTokenBudget {
  const requestHistory = buildAiRequestMessages(history);
  const historyText = requestHistory
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const safeLimit = Math.max(0, contextLimitChars);
  return {
    contextChars: context.usedChars,
    contextLimitChars: safeLimit,
    contextTokens: estimateAiTokenCount(context.content),
    contextTruncated: context.truncated,
    contextUsagePercent: safeLimit
      ? Math.min(100, Math.round((context.usedChars / safeLimit) * 100))
      : 0,
    historyTokens: estimateAiTokenCount(historyText),
    inputTokens: estimateAiTokenCount(input),
    totalTokens:
      estimateAiTokenCount(historyText) +
      estimateAiTokenCount(input) +
      estimateAiTokenCount(context.content),
  };
}

function formatContextBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let result = value;
  let unitIndex = 0;
  while (result >= 1024 && unitIndex < units.length - 1) {
    result /= 1024;
    unitIndex += 1;
  }
  return `${result >= 10 || unitIndex === 0 ? result.toFixed(0) : result.toFixed(1)} ${units[unitIndex]}`;
}

export function formatAiServerContext(snapshot: ServerMonitorSnapshot) {
  return [
    `系统: ${snapshot.operatingSystem || "-"}`,
    `主机名: ${snapshot.hostname || "-"}`,
    `内核: ${snapshot.kernel || "-"}`,
    `运行时间: ${Math.max(0, Math.round(snapshot.uptimeSeconds))} 秒`,
    `CPU: ${snapshot.cpuUsagePercent.toFixed(1)}%`,
    `内存: ${formatContextBytes(snapshot.memoryUsedBytes)} / ${formatContextBytes(snapshot.memoryTotalBytes)} (${snapshot.memoryUsagePercent.toFixed(1)}%)`,
    `磁盘: ${formatContextBytes(snapshot.diskUsedBytes)} / ${formatContextBytes(snapshot.diskTotalBytes)} (${snapshot.diskUsagePercent.toFixed(1)}%)`,
    `负载: ${snapshot.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`,
    `网络累计接收/发送: ${formatContextBytes(snapshot.networkReceiveBytes)} / ${formatContextBytes(snapshot.networkTransmitBytes)}`,
  ].join("\n");
}

export function assessAiTerminalCommand(command: string): AiCommandAssessment {
  try {
    normalizeAiTerminalCommand(command);
  } catch (error) {
    return {
      canInsert: false,
      label: "仅供查看",
      reason: error instanceof Error ? error.message : "无法提交到终端",
      risk: "caution",
    };
  }

  if (
    /(^|[;&|]\s*)(?:sudo\s+)?(?:rm\b|dd\b|mkfs(?:\.[\w-]+)?\b|wipefs\b|shutdown\b|reboot\b|poweroff\b|halt\b|kill(?:all)?\b|pkill\b)|:\(\)\s*\{\s*:\|:&\s*\};:/i.test(
      command,
    )
  ) {
    return {
      canInsert: true,
      label: "高风险",
      reason: "命令可能删除数据、终止进程或影响系统可用性",
      risk: "danger",
    };
  }

  if (
    /\bsudo\b|\b(?:chmod|chown)\s+-R\b|\bsystemctl\s+(?:start|stop|restart|disable|mask)\b|\b(?:apt|apt-get|dnf|yum|pacman|apk|brew)\s+(?:install|remove|purge|upgrade)\b|(?:curl|wget)[^\r\n|]*\|\s*(?:ba)?sh\b|(?:^|\s)>(?:>|\s*)\s*\/(?:etc|usr|var)\//i.test(
      command,
    )
  ) {
    return {
      canInsert: true,
      label: "需确认",
      reason: "命令可能修改系统配置、软件包或受保护文件",
      risk: "caution",
    };
  }

  return { canInsert: true, label: "低风险", risk: "safe" };
}

interface AiHistoryMessage {
  content: string;
  failed?: boolean;
  role: "user" | "assistant";
}

export function buildAiRequestMessages(
  messages: AiHistoryMessage[],
  limit = 20,
  maxChars = 18_000,
) {
  const candidates = messages
    .filter((message) => !message.failed && message.content.trim())
    .slice(-Math.max(1, limit))
    .map(({ role, content }) => ({ role, content }));
  const history: Array<{ content: string; role: "user" | "assistant" }> = [];
  let remainingChars = Math.max(1, maxChars);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) continue;
    if (message.content.length > remainingChars) {
      if (!history.length) {
        history.unshift({
          ...message,
          content: message.content.slice(-remainingChars),
        });
      }
      break;
    }
    history.unshift(message);
    remainingChars -= message.content.length;
  }
  if (history[0]?.role === "assistant") history.shift();
  return history;
}
