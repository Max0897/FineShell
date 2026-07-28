import {
  loadAllAiConversations,
  type AiConversationRecord,
} from "./ai-conversations";
import { redactAiContext } from "./ai-utils";

export type AiAuditCategory = "diagnostic" | "command" | "file";
export type AiAuditStatus =
  | "success"
  | "failed"
  | "cancelled"
  | "pending"
  | "inserted"
  | "executed"
  | "verified"
  | "applied"
  | "rolled-back"
  | "rejected"
  | "conflict";

export interface AiAuditEntry {
  action: string;
  category: AiAuditCategory;
  conversationId: string;
  durationMs?: number;
  hostId: string;
  hostName: string;
  id: string;
  label: string;
  occurredAt: string;
  planId?: string;
  status: AiAuditStatus;
}

export interface AiAuditQuery {
  category?: AiAuditCategory;
  hostId?: string;
  limit?: number;
}

function safeLabel(value: string, fallback: string) {
  const label = redactAiContext(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return label || fallback;
}

function validDate(value: unknown, fallback: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
}

function timestampDate(value: number, fallback: string) {
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    return fallback;
  }
  return new Date(value).toISOString();
}

function toolStatus(status: string): AiAuditStatus {
  if (status === "success" || status === "cancelled") return status;
  return "failed";
}

function commandStatus(status: string): AiAuditStatus {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "unavailable") return "failed";
  if (
    status === "inserted" ||
    status === "executed" ||
    status === "verified" ||
    status === "rejected"
  ) {
    return status;
  }
  return "pending";
}

function fileStatus(status: string): AiAuditStatus {
  if (
    status === "applied" ||
    status === "rolled-back" ||
    status === "rejected" ||
    status === "conflict" ||
    status === "failed"
  ) {
    return status;
  }
  return "pending";
}

function fileActionLabel(operation: string, fileName: string, target?: string) {
  const verb =
    operation === "create"
      ? "新建"
      : operation === "rename"
        ? "重命名"
        : operation === "delete"
          ? "删除"
          : "修改";
  return safeLabel(
    `${verb} ${fileName}${target ? ` -> ${target}` : ""}`,
    `${verb}远程文件`,
  );
}

export function buildAiAuditEntries(
  conversations: AiConversationRecord[],
  query: AiAuditQuery = {},
) {
  const entries: AiAuditEntry[] = [];
  for (const conversation of conversations) {
    const fallbackTime = validDate(
      conversation.updatedAt,
      new Date(0).toISOString(),
    );
    for (const message of conversation.messages) {
      for (const run of message.toolRuns ?? []) {
        const startedAt =
          Number.isFinite(run.startedAt) && run.startedAt > 0
            ? run.startedAt
            : Date.parse(fallbackTime);
        entries.push({
          action: run.name,
          category: "diagnostic",
          conversationId: conversation.id,
          durationMs: run.durationMs,
          hostId: conversation.hostId,
          hostName: conversation.hostName,
          id: `${conversation.id}:${message.id}:tool:${run.callId}`,
          label: safeLabel(run.label, "只读诊断"),
          occurredAt: timestampDate(
            startedAt + Math.max(0, run.durationMs ?? 0),
            fallbackTime,
          ),
          planId: run.planId,
          status: toolStatus(run.status),
        });
      }
      for (const record of message.commandRecords ?? []) {
        entries.push({
          action: "terminal_command",
          category: "command",
          conversationId: conversation.id,
          hostId: conversation.hostId,
          hostName: conversation.hostName,
          id: `${conversation.id}:${message.id}:command:${record.id}`,
          label: safeLabel(record.purpose, "终端命令提案"),
          occurredAt: validDate(record.occurredAt, fallbackTime),
          status: commandStatus(record.status),
        });
      }
      for (const change of message.fileChanges ?? []) {
        entries.push({
          action: `file_${change.operation}`,
          category: "file",
          conversationId: conversation.id,
          hostId: conversation.hostId,
          hostName: conversation.hostName,
          id: `${conversation.id}:${message.id}:file:${change.id}`,
          label: fileActionLabel(
            change.operation,
            change.fileName,
            change.targetFileName,
          ),
          occurredAt: validDate(
            change.rolledBackAt ?? change.appliedAt,
            fallbackTime,
          ),
          status: fileStatus(change.status),
        });
      }
    }
  }
  const limit = Math.min(1_000, Math.max(1, query.limit ?? 500));
  return entries
    .filter(
      (entry) =>
        (!query.hostId || entry.hostId === query.hostId) &&
        (!query.category || entry.category === query.category),
    )
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, limit);
}

export async function loadAiAuditEntries(query: AiAuditQuery = {}) {
  return buildAiAuditEntries(await loadAllAiConversations(), query);
}
