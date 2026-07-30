import {
  combineAiTerminalCommandAssessment,
  normalizeAiTerminalCommand,
  redactAiContext,
  type AiContextSource,
  type AiCommandAssessment,
  type AiCommandRisk,
} from "./ai-utils";
import type { AiToolCall, AiToolResult } from "./tauri-protocol";
import type { TerminalCommandSubmission } from "./terminal-utils";

export const AI_COMMAND_PROPOSAL_TOOL_NAME = "propose_terminal_command";
export const MAX_AI_COMMAND_PURPOSE_CHARS = 240;
export const MAX_AI_COMMAND_RISK_REASON_CHARS = 240;

export type AiCommandProposalStatus =
  | "pending"
  | "approved"
  | "executed"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "verified"
  | "rejected";

export type AiCommandVerification =
  | { kind: "service_active"; service: string }
  | { kind: "port_listening"; port: number; protocol: "tcp" | "udp" }
  | {
      kind: "config_syntax";
      validator: "nginx" | "apache" | "caddy" | "sshd" | "haproxy";
      path?: string;
    };

export interface AiCommandProposal {
  assessment: AiCommandAssessment;
  command: string;
  completedAt?: string;
  directory?: string;
  durationMs?: number;
  executedAt?: string;
  exitCode?: number;
  id: string;
  approvedAt?: string;
  purpose: string;
  resultOutput?: string;
  resultOutputTruncated?: boolean;
  resultUnavailableReason?: string;
  sessionId: string;
  status: AiCommandProposalStatus;
  submissionId?: string;
  verifiedAt?: string;
  verification?: AiCommandVerification;
}

export type AiCommandApprovalDecision =
  | {
      durationMs?: number;
      exitCode: number;
      kind: "execution_completed";
      output?: string;
      outputTruncated?: boolean;
    }
  | {
      durationMs?: number;
      kind: "execution_unavailable";
      reason: string;
    }
  | {
      kind: "rejected";
    }
  | {
      feedback: string;
      kind: "revision_requested";
    };

export interface AiCommandRecord {
  id: string;
  durationMs?: number;
  exitCode?: number;
  occurredAt?: string;
  purpose: string;
  risk: AiCommandAssessment["risk"];
  status:
    | "approved"
    | "executed"
    | "succeeded"
    | "failed"
    | "unavailable"
    | "verified"
    | "rejected"
    | "not-executed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function normalizeAiCommandVerification(
  value: unknown,
): AiCommandVerification {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("AI 返回的业务验证参数无效");
  }
  if (
    value.kind === "service_active" &&
    exactKeys(value, ["kind", "service"]) &&
    typeof value.service === "string" &&
    value.service.length > 0 &&
    value.service.length <= 128 &&
    !value.service.startsWith("-") &&
    /^[A-Za-z0-9_.@:-]+$/.test(value.service)
  ) {
    return { kind: value.kind, service: value.service };
  }
  if (
    value.kind === "port_listening" &&
    exactKeys(value, ["kind", "port", "protocol"]) &&
    Number.isInteger(value.port) &&
    typeof value.port === "number" &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    (value.protocol === "tcp" || value.protocol === "udp")
  ) {
    return { kind: value.kind, port: value.port, protocol: value.protocol };
  }
  if (
    value.kind === "config_syntax" &&
    (exactKeys(value, ["kind", "validator"]) ||
      exactKeys(value, ["kind", "validator", "path"])) &&
    ["nginx", "apache", "caddy", "sshd", "haproxy"].includes(
      String(value.validator),
    ) &&
    (value.path === undefined ||
      (typeof value.path === "string" &&
        value.path.startsWith("/") &&
        value.path.length <= 1_024 &&
        !value.path.split("/").some((part) => part === "." || part === "..") &&
        !/[\x00-\x1f\x7f]/.test(value.path)))
  ) {
    const validator = value.validator as
      | "nginx"
      | "apache"
      | "caddy"
      | "sshd"
      | "haproxy";
    return {
      kind: value.kind,
      validator,
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }
  throw new Error("AI 返回的业务验证参数无效");
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
  if (
    !isRecord(value) ||
    (!exactKeys(value, ["command", "purpose", "risk", "risk_reason"]) &&
      !exactKeys(value, [
        "command",
        "purpose",
        "risk",
        "risk_reason",
        "verification",
      ]))
  ) {
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
  if (
    value.risk !== "safe" &&
    value.risk !== "caution" &&
    value.risk !== "danger"
  ) {
    throw new Error("AI 返回的命令风险等级无效");
  }
  if (typeof value.risk_reason !== "string") {
    throw new Error("AI 返回的命令风险说明无效");
  }
  const riskReason = redactAiContext(value.risk_reason)
    .trim()
    .replace(/\s+/g, " ");
  if (
    !riskReason ||
    riskReason.length > MAX_AI_COMMAND_RISK_REASON_CHARS ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(riskReason)
  ) {
    throw new Error("AI 返回的命令风险说明无效");
  }
  const risk = value.risk as AiCommandRisk;
  const verification = value.verification === undefined
    ? undefined
    : normalizeAiCommandVerification(value.verification);
  return {
    assessment: combineAiTerminalCommandAssessment(command, risk, riskReason),
    command,
    directory: directory?.trim() || undefined,
    id: call.id,
    purpose,
    sessionId,
    status: "pending",
    verification,
  };
}

export function aiCommandProposalToolResult(
  call: AiToolCall,
  error: string,
): AiToolResult {
  return {
    callId: call.id,
    name: call.name,
    content: JSON.stringify({ ok: false, error }),
  };
}

export function aiCommandApprovalToolResult(
  call: AiToolCall,
  decision: AiCommandApprovalDecision,
): AiToolResult {
  const content =
    decision.kind === "execution_completed"
        ? {
            ok: decision.exitCode === 0,
            decision: "approved_and_completed",
            durationMs: decision.durationMs,
            exitCode: decision.exitCode,
            output: decision.output?.trim() || undefined,
            outputTruncated: decision.outputTruncated || undefined,
            message:
              decision.exitCode === 0
                ? "命令已获批准，终端已完成执行"
                : "命令已获批准，但终端执行返回非零退出码",
          }
        : decision.kind === "execution_unavailable"
          ? {
              ok: false,
              decision: "execution_result_unavailable",
              durationMs: decision.durationMs,
              error: decision.reason,
              message: "命令已获批准，但无法获取可靠的终端结束状态",
            }
      : decision.kind === "revision_requested"
        ? {
            ok: false,
            decision: "revision_requested",
            feedback: decision.feedback.trim(),
            message: "用户拒绝了当前命令，并要求按反馈重新提案",
          }
          : {
              ok: false,
              decision: "rejected",
              message: "用户拒绝了当前命令，不得执行",
            };
  return {
    callId: call.id,
    name: call.name,
    content: JSON.stringify(content),
  };
}

export function markAiCommandProposalApproved(
  proposal: AiCommandProposal,
  approvedAt = new Date().toISOString(),
) {
  if (proposal.status !== "pending") {
    throw new Error("当前终端命令提案不能再次审批");
  }
  return { ...proposal, approvedAt, status: "approved" as const };
}

export function aiCommandProposalMatchesSubmission(
  proposal: AiCommandProposal,
  submission: TerminalCommandSubmission,
) {
  if (
    proposal.status !== "approved" ||
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
    submissionId: submission.id,
  };
}

export function aiCommandProposalMatchesResult(
  proposal: AiCommandProposal,
  result: TerminalCommandSubmission,
) {
  return (
    proposal.status === "executed" &&
    proposal.sessionId === result.sessionId &&
    proposal.submissionId === result.id &&
    (result.phase === "completed" || result.phase === "unavailable")
  );
}

export function aiCommandApprovalDecisionFromSubmission(
  submission: TerminalCommandSubmission,
): AiCommandApprovalDecision | null {
  if (submission.phase === "unavailable") {
    return {
      durationMs: submission.durationMs,
      kind: "execution_unavailable",
      reason: submission.reason?.trim() || "终端未能提供可靠的执行结果",
    };
  }
  if (submission.phase !== "completed") return null;
  if (typeof submission.exitCode !== "number") {
    throw new Error("终端结果缺少退出码");
  }
  const redactedOutput = redactAiContext(submission.output ?? "");
  return {
    durationMs: submission.durationMs,
    exitCode: submission.exitCode,
    kind: "execution_completed",
    output: redactedOutput.slice(-12_000),
    outputTruncated:
      submission.outputTruncated === true || redactedOutput.length > 12_000,
  };
}

export function markAiCommandProposalCompleted(
  proposal: AiCommandProposal,
  result: TerminalCommandSubmission,
) {
  if (!aiCommandProposalMatchesResult(proposal, result)) {
    throw new Error("终端结果与命令提案不匹配");
  }
  if (result.phase === "unavailable") {
    return {
      ...proposal,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      resultUnavailableReason: result.reason,
      status: "unavailable" as const,
    };
  }
  if (typeof result.exitCode !== "number") {
    throw new Error("终端结果缺少退出码");
  }
  const redactedOutput = redactAiContext(result.output ?? "");
  const outputTruncated =
    result.outputTruncated === true || redactedOutput.length > 12_000;
  return {
    ...proposal,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    resultOutput: redactedOutput.slice(-12_000),
    resultOutputTruncated: outputTruncated,
    status:
      result.exitCode === 0 ? ("succeeded" as const) : ("failed" as const),
  };
}

export function markAiCommandProposalVerified(
  proposal: AiCommandProposal,
  verifiedAt = new Date().toISOString(),
) {
  if (
    proposal.status !== "executed" &&
    proposal.status !== "succeeded" &&
    proposal.status !== "failed"
  ) {
    throw new Error("只有已提交的命令才能标记为已分析");
  }
  return { ...proposal, status: "verified" as const, verifiedAt };
}

export function aiCommandRecordFromProposal(
  proposal: AiCommandProposal,
): AiCommandRecord {
  return {
    id: proposal.id,
    occurredAt:
      proposal.verifiedAt ??
      proposal.completedAt ??
      proposal.executedAt ??
      proposal.approvedAt,
    durationMs: proposal.durationMs,
    exitCode: proposal.exitCode,
    purpose: redactAiContext(proposal.purpose).slice(
      0,
      MAX_AI_COMMAND_PURPOSE_CHARS,
    ),
    risk: proposal.assessment.risk,
    status: proposal.status === "pending" ? "not-executed" : proposal.status,
  };
}

export function aiCommandResultContextSource(
  proposal: AiCommandProposal,
): AiContextSource | null {
  if (
    (proposal.status !== "succeeded" && proposal.status !== "failed") ||
    proposal.exitCode === undefined
  ) {
    return null;
  }
  const output = proposal.resultOutput?.trim();
  const duration = Math.max(0, proposal.durationMs ?? 0);
  const resultLines = [
    `命令用途: ${proposal.purpose}`,
    `退出码: ${proposal.exitCode}`,
    `耗时: ${duration} ms`,
    `输出${proposal.resultOutputTruncated ? "（已截断）" : ""}:`,
    output || "（无输出）",
  ];
  return {
    content: resultLines.join("\n"),
    id: `terminal-command-result:${proposal.id}`,
    label: `命令结果:${proposal.purpose.slice(0, 16)}-${proposal.id.slice(-4)}`,
    preserveWhitespace: true,
    truncateFrom: "start",
  };
}

export function aiCommandRiskColor(risk: AiCommandAssessment["risk"]) {
  if (risk === "danger") return "red";
  if (risk === "caution") return "orange";
  return "green";
}
