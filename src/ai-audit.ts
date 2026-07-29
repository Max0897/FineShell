import { loadAllAiConversations } from "./ai-conversations";
import { redactAiContext } from "./ai-utils";
import {
  invokeProtocolCommand,
  type AgentActionState,
  type AgentTaskEventKind,
  type AgentTaskEventPayload,
} from "./tauri-protocol";

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
  sequence: number;
  status: AiAuditStatus;
}

export interface AiAuditQuery {
  category?: AiAuditCategory;
  hostId?: string;
  limit?: number;
}

type HostNames = ReadonlyMap<string, string>;

const ACTION_AUDIT_EVENTS = new Set<AgentTaskEventKind>([
  "action_proposed",
  "action_rejected",
  "action_succeeded",
  "action_conflicted",
  "action_failed",
  "action_rolled_back",
  "action_rollback_conflicted",
  "action_rollback_failed",
  "action_verification_recorded",
]);

function safeLabel(value: string, fallback: string) {
  const label = redactAiContext(value)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return label || fallback;
}

function eventTime(value: number) {
  return Number.isFinite(value) && value >= 0
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

function actionCategory(action: AgentActionState): AiAuditCategory {
  if (action.tool === "insert_terminal_command") return "command";
  if (
    action.tool === "propose_file_edit" ||
    action.tool === "propose_file_operation"
  ) {
    return "file";
  }
  return "diagnostic";
}

function actionStatus(
  kind: AgentTaskEventKind,
  action: AgentActionState,
): AiAuditStatus {
  if (kind === "action_rejected") return "rejected";
  if (kind === "action_rolled_back") return "rolled-back";
  if (
    kind === "action_conflicted" ||
    kind === "action_rollback_conflicted"
  ) {
    return "conflict";
  }
  if (kind === "action_failed" || kind === "action_rollback_failed") {
    return "failed";
  }
  if (kind === "action_verification_recorded") {
    if (action.verificationStatus === "verified") return "verified";
    if (action.verificationStatus === "failed") return "failed";
  }
  if (kind === "action_succeeded") {
    if (actionCategory(action) === "file") return "applied";
    if (actionCategory(action) === "command") return "inserted";
    return "success";
  }
  return "pending";
}

function actionFallback(action: AgentActionState) {
  if (action.tool === "insert_terminal_command") return "终端命令填入";
  if (action.tool === "propose_file_edit") return "远程文件修改";
  if (action.tool === "propose_file_operation") return "远程文件操作";
  return "受控动作";
}

function actionEntry(
  event: AgentTaskEventPayload,
  hostNames: HostNames,
): AiAuditEntry | undefined {
  if (!event.actionId || !ACTION_AUDIT_EVENTS.has(event.kind)) return undefined;
  const action = event.task.actions.find((item) => item.id === event.actionId);
  if (!action) return undefined;
  return {
    action: action.tool,
    category: actionCategory(action),
    conversationId: event.task.conversationId,
    durationMs: action.durationMs ?? undefined,
    hostId: event.task.hostId,
    hostName: hostNames.get(event.task.hostId) ?? event.task.hostId,
    id: `${event.task.id}:${event.sequence}`,
    label: safeLabel(action.reason, actionFallback(action)),
    occurredAt: eventTime(event.task.updatedAt),
    planId: event.task.plan?.id,
    sequence: event.sequence,
    status: actionStatus(event.kind, action),
  };
}

function planEntry(
  event: AgentTaskEventPayload,
  hostNames: HostNames,
): AiAuditEntry | undefined {
  const plan = event.task.plan;
  if (event.kind !== "plan_completed" || !plan) return undefined;
  const failed = plan.status === "partial";
  return {
    action: "diagnostic_plan",
    category: "diagnostic",
    conversationId: event.task.conversationId,
    durationMs: plan.steps.reduce(
      (total, step) => total + (step.durationMs ?? 0),
      0,
    ),
    hostId: event.task.hostId,
    hostName: hostNames.get(event.task.hostId) ?? event.task.hostId,
    id: `${event.task.id}:${event.sequence}`,
    label: safeLabel(plan.description ?? "只读诊断计划", "只读诊断计划"),
    occurredAt: eventTime(event.task.updatedAt),
    planId: plan.id,
    sequence: event.sequence,
    status:
      plan.status === "cancelled"
        ? "cancelled"
        : failed
          ? "failed"
          : "success",
  };
}

export function buildAiAuditEntries(
  events: AgentTaskEventPayload[],
  query: AiAuditQuery = {},
  hostNames: HostNames = new Map(),
) {
  const limit = Math.min(1_000, Math.max(1, query.limit ?? 500));
  return events
    .map((event) => actionEntry(event, hostNames) ?? planEntry(event, hostNames))
    .filter((entry): entry is AiAuditEntry => Boolean(entry))
    .filter(
      (entry) =>
        (!query.hostId || entry.hostId === query.hostId) &&
        (!query.category || entry.category === query.category),
    )
    .sort(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        right.sequence - left.sequence,
    )
    .slice(0, limit);
}

async function loadHostNames() {
  try {
    return new Map(
      (await loadAllAiConversations()).map((conversation) => [
        conversation.hostId,
        conversation.hostName,
      ]),
    );
  } catch {
    return new Map<string, string>();
  }
}

export async function loadAiAuditEntries(query: AiAuditQuery = {}) {
  const limit = Math.min(1_000, Math.max(1, query.limit ?? 500));
  const [events, hostNames] = await Promise.all([
    invokeProtocolCommand<AgentTaskEventPayload[]>("ai_task_audit_events", {
      limit,
    }),
    loadHostNames(),
  ]);
  return buildAiAuditEntries(events, query, hostNames);
}
