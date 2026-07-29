import { sanitizePersistedAiToolRuns, type AiToolRun } from "./ai-tools";
import {
  sanitizePersistedAiDiagnosticPlans,
  type AiDiagnosticPlan,
} from "./ai-diagnostic-plans";
import {
  aiFileEditLineSummary,
  MAX_AI_FILE_EDIT_CHARS,
  type AiFileChangeStatus,
  type AiFileChangeRecord,
  type AiFileChangeOperation,
} from "./ai-file-edits";
import {
  MAX_AI_COMMAND_PURPOSE_CHARS,
  type AiCommandRecord,
} from "./ai-command-proposals";
import { redactAiContext } from "./ai-utils";

const DATABASE_NAME = "fineshell.ai";
const DATABASE_VERSION = 1;
const CONVERSATION_STORE = "conversations";

export const MAX_AI_CONVERSATIONS_PER_HOST = 30;
export const MAX_AI_CONVERSATIONS_TOTAL = 100;
export const MAX_AI_CONVERSATION_MESSAGES = 60;
export const MAX_AI_CONVERSATION_CHARS = 160_000;

export interface AiConversationMessageRecord {
  content: string;
  commandRecords?: AiCommandRecord[];
  contextLabels?: string[];
  diagnosticPlans?: AiDiagnosticPlan[];
  fileChanges?: AiFileChangeRecord[];
  id: string;
  role: "user" | "assistant";
  taskId?: string;
  toolRuns?: AiToolRun[];
}

export interface AiConversationSummaryRecord {
  content: string;
  throughMessageId: string;
  updatedAt: string;
}

export interface AiConversationRecord {
  createdAt: string;
  hostId: string;
  hostName: string;
  id: string;
  messages: AiConversationMessageRecord[];
  summary?: AiConversationSummaryRecord;
  title: string;
  updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

let databasePromise: Promise<IDBDatabase> | undefined;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function isoDate(value: unknown, fallback: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return new Date(value).toISOString();
}

function optionalIsoDate(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function fileChangeStatus(value: unknown): AiFileChangeStatus | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "pending") return "not-applied";
  return [
    "not-applied",
    "applied",
    "rolled-back",
    "rejected",
    "conflict",
    "failed",
  ].includes(value)
    ? (value as AiFileChangeStatus)
    : undefined;
}

function boundedLineCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : undefined;
}

function fileChangeOperation(value: unknown): AiFileChangeOperation {
  return value === "create" || value === "rename" || value === "delete"
    ? value
    : "edit";
}

function fileNameFromPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\/+$/, "");
  return boundedText(normalized.slice(normalized.lastIndexOf("/") + 1), 160);
}

function sanitizeFileChanges(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const changes = value
    .map((item): AiFileChangeRecord | undefined => {
      if (!isRecord(item)) return undefined;
      const originalFile = isRecord(item.originalFile)
        ? item.originalFile
        : undefined;
      const operation = fileChangeOperation(item.operation);
      const id = boundedText(item.id, 160);
      const fileName =
        boundedText(item.fileName, 160) ??
        boundedText(originalFile?.name, 160) ??
        fileNameFromPath(item.path);
      const targetFileName =
        operation === "rename"
          ? (boundedText(item.targetFileName, 160) ??
            fileNameFromPath(item.targetPath))
          : undefined;
      const status = fileChangeStatus(item.status);
      if (!id || !fileName || !status) return undefined;

      let addedLines = boundedLineCount(item.addedLines);
      let removedLines = boundedLineCount(item.removedLines);
      if (operation === "rename") {
        addedLines ??= 0;
        removedLines ??= 0;
      } else if (
        (addedLines === undefined || removedLines === undefined) &&
        (operation === "create" || typeof originalFile?.content === "string") &&
        (operation === "delete" || typeof item.content === "string")
      ) {
        const originalContent =
          operation === "create" ? "" : String(originalFile?.content ?? "");
        const nextContent =
          operation === "delete" ? "" : String(item.content ?? "");
        if (
          originalContent.length <= MAX_AI_FILE_EDIT_CHARS &&
          nextContent.length <= MAX_AI_FILE_EDIT_CHARS
        ) {
          const summary = aiFileEditLineSummary(originalContent, nextContent);
          addedLines = summary.addedLines;
          removedLines = summary.removedLines;
        }
      }
      return {
        id,
        fileName,
        operation,
        status,
        targetFileName,
        addedLines: addedLines ?? 0,
        removedLines: removedLines ?? 0,
        appliedAt: optionalIsoDate(item.appliedAt),
        rolledBackAt: optionalIsoDate(item.rolledBackAt),
      };
    })
    .filter((item): item is AiFileChangeRecord => Boolean(item))
    .slice(0, 8);
  return changes.length ? changes : undefined;
}

function sanitizeContextLabels(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const labels = Array.from(
    new Set(
      value
        .map((label) => boundedText(label, 40))
        .filter((label): label is string => Boolean(label)),
    ),
  ).slice(0, 12);
  return labels.length ? labels : undefined;
}

function sanitizeCommandRecords(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const records = value
    .map((item): AiCommandRecord | undefined => {
      if (!isRecord(item)) return undefined;
      const id = boundedText(item.id, 160);
      const purposeValue = boundedText(
        item.purpose,
        MAX_AI_COMMAND_PURPOSE_CHARS,
      );
      const purpose = purposeValue
        ? redactAiContext(purposeValue).slice(0, MAX_AI_COMMAND_PURPOSE_CHARS)
        : undefined;
      const assessment = isRecord(item.assessment)
        ? item.assessment
        : undefined;
      const riskValue = item.risk ?? assessment?.risk;
      const risk =
        riskValue === "safe" ||
        riskValue === "caution" ||
        riskValue === "danger"
          ? riskValue
          : undefined;
      const status =
        item.status === "inserted" ||
        item.status === "executed" ||
        item.status === "succeeded" ||
        item.status === "failed" ||
        item.status === "unavailable" ||
        item.status === "verified" ||
        item.status === "rejected"
          ? item.status
          : item.status === "not-inserted" || item.status === "pending"
            ? "not-inserted"
            : undefined;
      if (!id || !purpose || !risk || !status) return undefined;
      return {
        id,
        occurredAt: optionalIsoDate(item.occurredAt),
        durationMs:
          typeof item.durationMs === "number" &&
          Number.isFinite(item.durationMs) &&
          item.durationMs >= 0
            ? Math.min(Math.round(item.durationMs), 86_400_000)
            : undefined,
        exitCode:
          typeof item.exitCode === "number" &&
          Number.isInteger(item.exitCode) &&
          item.exitCode >= 0 &&
          item.exitCode <= 255
            ? item.exitCode
            : undefined,
        purpose,
        risk,
        status,
      };
    })
    .filter((item): item is AiCommandRecord => Boolean(item))
    .slice(0, 8);
  return records.length ? records : undefined;
}

function sanitizeMessage(
  value: unknown,
): AiConversationMessageRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, 160);
  const role =
    value.role === "user" || value.role === "assistant"
      ? value.role
      : undefined;
  const content =
    boundedText(value.content, role === "user" ? 4_000 : 40_000) ?? "";
  const toolRuns =
    role === "assistant"
      ? sanitizePersistedAiToolRuns(value.toolRuns)
      : undefined;
  const diagnosticPlans =
    role === "assistant"
      ? sanitizePersistedAiDiagnosticPlans(value.diagnosticPlans)
      : undefined;
  const fileChanges =
    role === "assistant"
      ? sanitizeFileChanges(
          value.fileChanges ?? [
            ...(Array.isArray(value.fileEditProposals)
              ? value.fileEditProposals
              : []),
            ...(Array.isArray(value.fileOperationProposals)
              ? value.fileOperationProposals
              : []),
          ],
        )
      : undefined;
  const commandRecords =
    role === "assistant"
      ? sanitizeCommandRecords(value.commandRecords ?? value.commandProposals)
      : undefined;
  if (
    !id ||
    !role ||
    value.failed === true ||
    (!content && role === "user") ||
    (!content &&
      !toolRuns?.length &&
      !diagnosticPlans?.length &&
      !fileChanges?.length &&
      !commandRecords?.length)
  ) {
    return undefined;
  }
  return {
    id,
    role,
    content,
    contextLabels: sanitizeContextLabels(value.contextLabels),
    ...(role === "assistant"
      ? {
          taskId: boundedText(value.taskId, 160),
          toolRuns,
          diagnosticPlans,
          fileChanges,
          commandRecords,
        }
      : {}),
  };
}

function sanitizeMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  const candidates = value
    .map(sanitizeMessage)
    .filter((message): message is AiConversationMessageRecord =>
      Boolean(message),
    )
    .slice(-MAX_AI_CONVERSATION_MESSAGES);
  const messages: AiConversationMessageRecord[] = [];
  let remaining = MAX_AI_CONVERSATION_CHARS;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) continue;
    const toolChars =
      message.toolRuns?.reduce(
        (total, run) =>
          total + (run.summary?.length ?? 0) + (run.error?.length ?? 0),
        0,
      ) ?? 0;
    const planChars =
      message.diagnosticPlans?.reduce(
        (total, plan) => total + (plan.description?.length ?? 0) + 96,
        0,
      ) ?? 0;
    const fileChangeChars =
      message.fileChanges?.reduce(
        (total, change) => total + change.fileName.length + 64,
        0,
      ) ?? 0;
    const commandRecordChars =
      message.commandRecords?.reduce(
        (total, record) => total + record.purpose.length + 32,
        0,
      ) ?? 0;
    const messageChars =
      message.content.length +
      toolChars +
      planChars +
      fileChangeChars +
      commandRecordChars;
    if (messageChars > remaining) break;
    messages.unshift(message);
    remaining -= messageChars;
  }
  if (messages[0]?.role === "assistant") messages.shift();
  return messages;
}

function sanitizeSummary(
  value: unknown,
): AiConversationSummaryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const content = boundedText(value.content, 4_000);
  const throughMessageId = boundedText(value.throughMessageId, 160);
  if (!content || !throughMessageId) return undefined;
  return {
    content: redactAiContext(content),
    throughMessageId,
    updatedAt: isoDate(value.updatedAt, new Date().toISOString()),
  };
}

export function sanitizeAiConversation(
  value: unknown,
): AiConversationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, 160);
  const hostId = boundedText(value.hostId, 160);
  if (!id || !hostId) return undefined;
  const now = new Date().toISOString();
  const createdAt = isoDate(value.createdAt, now);
  return {
    id,
    hostId,
    hostName: boundedText(value.hostName, 80) ?? "未命名主机",
    title: boundedText(value.title, 80) ?? "新对话",
    createdAt,
    updatedAt: isoDate(value.updatedAt, createdAt),
    messages: sanitizeMessages(value.messages),
    summary: sanitizeSummary(value.summary),
  };
}

export function aiConversationTitleFromPrompt(prompt: string) {
  const title = prompt.trim().replace(/\s+/g, " ");
  if (!title) return "新对话";
  return title.length > 36 ? `${title.slice(0, 36)}…` : title;
}

export function aiConversationExportFilename(
  conversation: AiConversationRecord,
) {
  const title =
    conversation.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "AI-对话";
  return `${title}.md`;
}

export function serializeAiConversationMarkdown(
  conversation: AiConversationRecord,
) {
  const sanitized = sanitizeAiConversation(conversation);
  if (!sanitized) throw new Error("AI 对话内容无效");
  const lines = [
    `# ${sanitized.title}`,
    "",
    `- 主机：${sanitized.hostName}`,
    `- 创建时间：${sanitized.createdAt}`,
    `- 更新时间：${sanitized.updatedAt}`,
  ];
  for (const message of sanitized.messages) {
    lines.push("", `## ${message.role === "user" ? "用户" : "AI"}`, "");
    if (message.contextLabels?.length) {
      lines.push(`> 上下文来源：${message.contextLabels.join("、")}`, "");
    }
    if (message.toolRuns?.length) {
      lines.push("> 诊断工具：");
      for (const run of message.toolRuns) {
        const status =
          run.status === "success"
            ? "已完成"
            : run.status === "cancelled"
              ? "已取消"
              : "不可用";
        lines.push(
          `> - ${run.label}${run.detail ? `（${run.detail}）` : ""}：${status}`,
        );
        const detail = run.summary ?? run.error;
        if (detail) {
          lines.push(...detail.split("\n").map((line) => `>   ${line}`));
        }
      }
      lines.push("");
    }
    if (message.diagnosticPlans?.length) {
      lines.push("> 诊断计划：");
      for (const plan of message.diagnosticPlans) {
        const status =
          plan.status === "completed"
            ? "已完成"
            : plan.status === "partial"
              ? "部分完成"
              : "已取消";
        lines.push(`> - ${plan.description ?? "只读诊断"}：${status}`);
      }
      lines.push("");
    }
    if (message.commandRecords?.length) {
      lines.push("> 终端命令提案：");
      for (const record of message.commandRecords) {
        const status =
          record.status === "verified"
            ? "已分析"
            : record.status === "succeeded"
              ? "执行成功"
              : record.status === "failed"
                ? "执行失败"
                : record.status === "unavailable"
                  ? "结果不可用"
                  : record.status === "executed"
                    ? "已提交"
                    : record.status === "inserted"
                      ? "已填入"
                      : record.status === "rejected"
                        ? "已拒绝"
                        : "未填入";
        const risk =
          record.risk === "danger"
            ? "高风险"
            : record.risk === "caution"
              ? "需确认"
              : "低风险";
        lines.push(`> - ${record.purpose}：${risk}，${status}`);
      }
      lines.push("");
    }
    if (message.fileChanges?.length) {
      lines.push("> 文件变更：");
      for (const change of message.fileChanges) {
        const status =
          change.status === "applied"
            ? "已应用"
            : change.status === "not-applied"
              ? "未应用"
              : change.status === "rolled-back"
                ? "已回滚"
                : change.status === "rejected"
                  ? "已拒绝"
                  : change.status === "conflict"
                    ? "远端已变化"
                    : change.status === "failed"
                      ? "应用失败"
                      : "等待审阅";
        lines.push(
          `> - ${
            change.operation === "edit"
              ? "修改"
              : change.operation === "create"
                ? "新建"
                : change.operation === "rename"
                  ? "重命名"
                  : "删除"
          } ${change.fileName}${change.targetFileName ? ` → ${change.targetFileName}` : ""}：${status}（+${change.addedLines} / -${change.removedLines}）`,
        );
      }
      lines.push("");
    }
    lines.push(message.content);
  }
  return `${lines.join("\n")}\n`;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("数据库请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("数据库事务已取消"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("数据库事务失败"));
  });
}

function openDatabase() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
        const store = database.createObjectStore(CONVERSATION_STORE, {
          keyPath: "id",
        });
        store.createIndex("hostId", "hostId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开 AI 对话数据库"));
    request.onblocked = () => reject(new Error("AI 对话数据库升级被阻止"));
  });
  return databasePromise;
}

export async function loadAiConversations(hostId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATION_STORE, "readonly");
  const completed = transactionDone(transaction);
  const records = await requestResult(
    transaction.objectStore(CONVERSATION_STORE).index("hostId").getAll(hostId),
  );
  await completed;
  return records
    .map(sanitizeAiConversation)
    .filter((record): record is AiConversationRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_AI_CONVERSATIONS_PER_HOST);
}

export async function loadAllAiConversations() {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATION_STORE, "readonly");
  const completed = transactionDone(transaction);
  const records = await requestResult(
    transaction.objectStore(CONVERSATION_STORE).getAll(),
  );
  await completed;
  return records
    .map(sanitizeAiConversation)
    .filter((record): record is AiConversationRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_AI_CONVERSATIONS_TOTAL);
}

export async function saveAiConversation(value: AiConversationRecord) {
  const conversation = sanitizeAiConversation(value);
  if (!conversation) throw new Error("AI 对话内容无效");
  if (!conversation.messages.length) {
    await deleteAiConversation(conversation.id);
    return conversation;
  }

  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATION_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(CONVERSATION_STORE);
  const stored = await requestResult(store.getAll());
  const records = stored
    .map(sanitizeAiConversation)
    .filter((record): record is AiConversationRecord => Boolean(record))
    .filter((record) => record.id !== conversation.id);
  records.push(conversation);

  const keep = new Set<string>();
  const perHostCounts = new Map<string, number>();
  for (const record of records.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )) {
    const hostCount = perHostCounts.get(record.hostId) ?? 0;
    if (
      keep.size >= MAX_AI_CONVERSATIONS_TOTAL ||
      hostCount >= MAX_AI_CONVERSATIONS_PER_HOST
    ) {
      continue;
    }
    keep.add(record.id);
    perHostCounts.set(record.hostId, hostCount + 1);
  }

  store.put(conversation);
  for (const record of records) {
    if (!keep.has(record.id)) store.delete(record.id);
  }
  await completed;
  return conversation;
}

export async function deleteAiConversation(conversationId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATION_STORE, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CONVERSATION_STORE).delete(conversationId);
  await completed;
}
