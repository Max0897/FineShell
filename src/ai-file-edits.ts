import { diffLines } from "diff";
import type { AiToolCall, AiToolResult } from "./tauri-protocol";
import {
  MAX_AI_REMOTE_FILE_BYTES,
  aiRemoteFileContextError,
  aiRemoteFileContextSource,
  buildAiContextPayload,
  redactAiContext,
  type AiRemoteFileContext,
} from "./ai-utils";

export const AI_FILE_EDIT_TOOL_NAME = "propose_file_edit";
export const MAX_AI_FILE_EDIT_CHARS = 60_000;

export type AiFileEditProposalStatus =
  | "pending"
  | "applied"
  | "rolled-back"
  | "rejected"
  | "conflict"
  | "failed";

export interface AiFileEditProposal {
  appliedAt?: string;
  appliedFile?: AiRemoteFileContext;
  content: string;
  error?: string;
  id: string;
  originalFile: AiRemoteFileContext;
  reviewed?: boolean;
  rollbackError?: string;
  rolledBackAt?: string;
  sessionId: string;
  status: AiFileEditProposalStatus;
}

export type AiFileChangeStatus =
  | Exclude<AiFileEditProposalStatus, "pending">
  | "not-applied";

export type AiFileChangeOperation = "edit" | "create" | "rename" | "delete";

export interface AiFileChangeRecord {
  addedLines: number;
  appliedAt?: string;
  fileName: string;
  id: string;
  operation: AiFileChangeOperation;
  removedLines: number;
  rolledBackAt?: string;
  status: AiFileChangeStatus;
  targetFileName?: string;
}

export interface AiFileEditDiffPart {
  count: number;
  kind: "added" | "removed" | "unchanged";
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(call: AiToolCall) {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error("AI 返回了无效的文件修改参数");
  }
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error("AI 返回了无效的文件修改参数");
  }
  return value;
}

export function isAiFileEditToolCall(call: AiToolCall) {
  return call.name === AI_FILE_EDIT_TOOL_NAME;
}

export function aiFileEditEligibilityError(
  file: AiRemoteFileContext | null,
  context: string,
  maxContextChars: number,
) {
  if (!file) return "请先从文件管理器将文件发送给 AI";
  const sizeError = aiRemoteFileContextError(file.size);
  if (sizeError) return sizeError;
  if (redactAiContext(file.content) !== file.content) {
    return "文件包含疑似密钥、令牌或口令，只能分析，不能生成可直接应用的修改";
  }
  const source = aiRemoteFileContextSource(file);
  const completeContext = buildAiContextPayload(
    [source],
    [source.id],
    Math.max(maxContextChars, source.content.length + source.label.length + 128),
  );
  const boundedContext = buildAiContextPayload(
    [source],
    [source.id],
    maxContextChars,
  );
  if (
    !completeContext ||
    boundedContext !== completeContext ||
    !context.includes(completeContext)
  ) {
    return "文件内容未完整加入本次上下文，只能分析，不能生成覆盖修改";
  }
  return null;
}

export function proposedFileContentError(
  content: string,
  originalContent: string,
) {
  if (content.includes("\0")) return "建议内容包含无效的二进制字符";
  if (content.length > MAX_AI_FILE_EDIT_CHARS) {
    return "建议内容超过 60000 字符，无法安全应用";
  }
  if (new TextEncoder().encode(content).length > MAX_AI_REMOTE_FILE_BYTES) {
    return "建议内容超过 256 KiB，无法安全应用";
  }
  if (content === originalContent) return "建议内容与远程文件相同";
  return null;
}

export function createAiFileEditProposal(
  call: AiToolCall,
  availableFiles: AiRemoteFileContext | AiRemoteFileContext[],
  sessionId: string,
): AiFileEditProposal {
  if (!isAiFileEditToolCall(call)) {
    throw new Error("AI 返回了不支持的文件修改工具");
  }
  const argumentsValue = parseArguments(call);
  const path = argumentsValue.path;
  const content = argumentsValue.content;
  const files = Array.isArray(availableFiles)
    ? availableFiles
    : [availableFiles];
  const file = typeof path === "string"
    ? files.find((candidate) => candidate.path === path)
    : undefined;
  if (!file) {
    throw new Error("AI 提议修改的文件与当前上下文不一致");
  }
  if (typeof content !== "string") {
    throw new Error("AI 返回的文件内容无效");
  }
  const contentError = proposedFileContentError(content, file.content);
  if (contentError) throw new Error(contentError);
  return {
    content,
    id: call.id,
    originalFile: { ...file },
    sessionId,
    status: "pending",
  };
}

export function aiFileEditToolResult(
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
            message: "文件修改提案已记录，正在等待用户审阅，尚未写入远程文件",
          },
    ),
  };
}

export function aiFileEditDiff(
  originalContent: string,
  proposedContent: string,
): AiFileEditDiffPart[] {
  const changes = diffLines(originalContent, proposedContent, {
    maxEditLength: 20_000,
  });
  const values =
    changes ?? [
      { removed: true, value: originalContent },
      { added: true, value: proposedContent },
    ];
  return values.map((change) => ({
    count:
      ("count" in change ? change.count : undefined) ??
      change.value.split("\n").length,
    kind: change.added ? "added" : change.removed ? "removed" : "unchanged",
    value: change.value,
  }));
}

export function aiFileEditLineSummary(
  originalContent: string,
  proposedContent: string,
) {
  return aiFileEditDiff(originalContent, proposedContent).reduce(
    (summary, part) => {
      if (part.kind === "added") summary.addedLines += part.count;
      if (part.kind === "removed") summary.removedLines += part.count;
      return summary;
    },
    { addedLines: 0, removedLines: 0 },
  );
}

export function markAiFileEditApplied(
  proposal: AiFileEditProposal,
  content: string,
  appliedFile: AiRemoteFileContext,
  appliedAt: string,
) {
  if (
    appliedFile.path !== proposal.originalFile.path ||
    appliedFile.content !== content
  ) {
    throw new Error("远程文件写入结果与修改提案不一致");
  }
  return {
    ...proposal,
    appliedAt,
    appliedFile: { ...appliedFile },
    content,
    error: undefined,
    rollbackError: undefined,
    rolledBackAt: undefined,
    status: "applied" as const,
  };
}

export function aiFileEditRollbackEligibilityError(
  proposal: AiFileEditProposal,
) {
  if (proposal.status !== "applied" || !proposal.appliedFile) {
    return "当前文件修改没有可回滚的应用快照";
  }
  if (proposal.appliedFile.path !== proposal.originalFile.path) {
    return "文件修改快照路径不一致";
  }
  return null;
}

export function markAiFileEditRolledBack(
  proposal: AiFileEditProposal,
  rolledBackAt: string,
) {
  const error = aiFileEditRollbackEligibilityError(proposal);
  if (error) throw new Error(error);
  return {
    ...proposal,
    error: undefined,
    rollbackError: undefined,
    rolledBackAt,
    status: "rolled-back" as const,
  };
}
