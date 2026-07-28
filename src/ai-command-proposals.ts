import {
  assessAiTerminalCommand,
  normalizeAiTerminalCommand,
  redactAiContext,
  type AiCommandAssessment,
} from "./ai-utils";
import type { AiToolCall, AiToolResult } from "./tauri-protocol";
import type { TerminalCommandSubmission } from "./terminal-utils";

export const AI_COMMAND_PROPOSAL_TOOL_NAME = "propose_terminal_command";
export const MAX_AI_COMMAND_PURPOSE_CHARS = 240;

export type AiCommandProposalStatus =
  | "pending"
  | "inserted"
  | "executed"
  | "verified"
  | "rejected";

export interface AiCommandProposal {
  assessment: AiCommandAssessment;
  command: string;
  directory?: string;
  executedAt?: string;
  id: string;
  insertedAt?: string;
  purpose: string;
  sessionId: string;
  status: AiCommandProposalStatus;
  verifiedAt?: string;
}

export interface AiCommandRecord {
  id: string;
  purpose: string;
  risk: AiCommandAssessment["risk"];
  status: "inserted" | "executed" | "verified" | "rejected" | "not-inserted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function isAiCommandProposalToolCall(call: AiToolCall) {
  return call.name === AI_COMMAND_PROPOSAL_TOOL_NAME;
}

export function createAiCommandProposal(
  call: AiToolCall,
  sessionId: string,
  directory?: string | null,
): AiCommandProposal {
  if (!isAiCommandProposalToolCall(call)) {
    throw new Error("AI 返回了不支持的终端命令工具");
  }
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error("AI 返回了无效的终端命令参数");
  }
  if (!isRecord(value) || !exactKeys(value, ["command", "purpose"])) {
    throw new Error("AI 返回了无效的终端命令参数");
  }
  if (typeof value.command !== "string") {
    throw new Error("AI 返回的终端命令无效");
  }
  const command = normalizeAiTerminalCommand(value.command);
  if (typeof value.purpose !== "string") {
    throw new Error("AI 返回的命令用途无效");
  }
  const purpose = redactAiContext(value.purpose).trim().replace(/\s+/g, " ");
  if (
    !purpose ||
    purpose.length > MAX_AI_COMMAND_PURPOSE_CHARS ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(purpose)
  ) {
    throw new Error("AI 返回的命令用途无效");
  }
  return {
    assessment: assessAiTerminalCommand(command),
    command,
    directory: directory?.trim() || undefined,
    id: call.id,
    purpose,
    sessionId,
    status: "pending",
  };
}

export function aiCommandProposalToolResult(
  call: AiToolCall,
  error?: string,
): AiToolResult {
  return {
    callId: call.id,
    name: call.name,
    content: JSON.stringify(
      error
        ? { ok: false, error }
        : {
            ok: true,
            proposalCaptured: true,
            message: "终端命令提案已记录，等待用户确认，尚未填入或执行",
          },
    ),
  };
}

export function markAiCommandProposalInserted(
  proposal: AiCommandProposal,
  insertedAt = new Date().toISOString(),
) {
  if (proposal.status !== "pending") {
    throw new Error("当前终端命令提案不能再次填入");
  }
  return { ...proposal, insertedAt, status: "inserted" as const };
}

export function aiCommandProposalMatchesSubmission(
  proposal: AiCommandProposal,
  submission: TerminalCommandSubmission,
) {
  if (
    proposal.status !== "inserted" ||
    proposal.sessionId !== submission.sessionId
  ) {
    return false;
  }
  try {
    return normalizeAiTerminalCommand(submission.command) === proposal.command;
  } catch {
    return false;
  }
}

export function markAiCommandProposalExecuted(
  proposal: AiCommandProposal,
  submission: TerminalCommandSubmission,
) {
  if (!aiCommandProposalMatchesSubmission(proposal, submission)) {
    throw new Error("终端提交与命令提案不匹配");
  }
  return {
    ...proposal,
    executedAt: submission.submittedAt,
    status: "executed" as const,
  };
}

export function markAiCommandProposalVerified(
  proposal: AiCommandProposal,
  verifiedAt = new Date().toISOString(),
) {
  if (proposal.status !== "executed") {
    throw new Error("只有已提交的命令才能标记为已分析");
  }
  return { ...proposal, status: "verified" as const, verifiedAt };
}

export function aiCommandRecordFromProposal(
  proposal: AiCommandProposal,
): AiCommandRecord {
  return {
    id: proposal.id,
    purpose: redactAiContext(proposal.purpose).slice(
      0,
      MAX_AI_COMMAND_PURPOSE_CHARS,
    ),
    risk: proposal.assessment.risk,
    status:
      proposal.status === "pending" ? "not-inserted" : proposal.status,
  };
}

export function aiCommandRiskColor(risk: AiCommandAssessment["risk"]) {
  if (risk === "danger") return "red";
  if (risk === "caution") return "orange";
  return "green";
}
