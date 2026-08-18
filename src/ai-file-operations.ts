import {
  MAX_AI_FILE_EDIT_CHARS,
  aiFileEditLineSummary,
  type AiFileEditProposalStatus,
} from "./ai-file-edits";
import type { AiToolCall, AiToolResult } from "./tauri-protocol";
import {
  MAX_AI_REMOTE_FILE_BYTES,
  containsAiRedactionMarker,
  type AiRemoteFileContext,
} from "./ai-utils";

export const AI_FILE_OPERATION_TOOL_NAME = "propose_file_operation";

export type AiFileOperationKind = "create" | "rename" | "delete";

export interface AiFileOperationProposal {
  appliedAt?: string;
  appliedFile?: AiRemoteFileContext;
  content?: string;
  error?: string;
  id: string;
  operation: AiFileOperationKind;
  originalFile?: AiRemoteFileContext;
  path: string;
  reviewed?: boolean;
  rollbackError?: string;
  rolledBackAt?: string;
  sessionId: string;
  status: AiFileEditProposalStatus;
  targetPath?: string;
}

export interface AiFileOperationResult {
  file: AiRemoteFileContext | null;
}

export interface AiFileOperationExecutionRequest {
  content?: string;
  expectedContent?: string;
  operation: AiFileOperationKind;
  path: string;
  targetPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(call: AiToolCall) {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error("AI 返回了无效的文件操作参数");
  }
  if (!isRecord(value)) throw new Error("AI 返回了无效的文件操作参数");
  return value;
}

export function isAiFileOperationToolCall(call: AiToolCall) {
  return call.name === AI_FILE_OPERATION_TOOL_NAME;
}

export function normalizeAiRemotePath(path: string) {
  if (!path.startsWith("/") || path.includes("\0") || /[\r\n]/.test(path)) {
    throw new Error("AI 文件操作必须使用有效的远程绝对路径");
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("AI 文件操作路径不能包含相对路径片段");
  }
  return segments.length ? `/${segments.join("/")}` : "/";
}

export function aiRemoteParentPath(path: string) {
  const normalized = normalizeAiRemotePath(path);
  if (normalized === "/") return "/";
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent || "/";
}

export function aiRemoteFileName(path: string) {
  const normalized = normalizeAiRemotePath(path);
  return normalized === "/" ? "/" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function aiFileOperationContentError(content: string) {
  if (content.includes("\0")) return "新建文件内容包含无效的二进制字符";
  if (containsAiRedactionMarker(content)) {
    return "新建文件内容包含脱敏占位符，已阻止写入远程文件";
  }
  if (content.length > MAX_AI_FILE_EDIT_CHARS) {
    return "新建文件内容超过 60000 字符";
  }
  if (new TextEncoder().encode(content).length > MAX_AI_REMOTE_FILE_BYTES) {
    return "新建文件内容超过 256 KiB";
  }
  return null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function createAiFileOperationProposal(
  call: AiToolCall,
  availableFiles: AiRemoteFileContext[],
  operationDirectory: string | null,
  sessionId: string,
): AiFileOperationProposal {
  if (!isAiFileOperationToolCall(call)) {
    throw new Error("AI 返回了不支持的文件操作工具");
  }
  const directory = operationDirectory
    ? normalizeAiRemotePath(operationDirectory)
    : null;
  const args = parseArguments(call);
  const operation = args.operation;
  const rawPath = args.path;
  if (
    !matchesOperation(operation) ||
    typeof rawPath !== "string"
  ) {
    throw new Error("AI 返回了无效的文件操作参数");
  }
  const path = normalizeAiRemotePath(rawPath);
  if (path === "/") throw new Error("禁止对远程根目录执行 AI 文件操作");

  if (operation === "create") {
    if (!exactKeys(args, ["operation", "path", "content"])) {
      throw new Error("AI 返回了无效的新建文件参数");
    }
    if (!directory || aiRemoteParentPath(path) !== directory) {
      throw new Error("AI 只能在当前远程目录中新建文件");
    }
    if (typeof args.content !== "string") {
      throw new Error("AI 返回的新建文件内容无效");
    }
    const contentError = aiFileOperationContentError(args.content);
    if (contentError) throw new Error(contentError);
    return {
      content: args.content,
      id: call.id,
      operation,
      path,
      sessionId,
      status: "pending",
    };
  }

  const originalFile = availableFiles.find((file) => file.path === path);
  if (!originalFile) {
    throw new Error("AI 文件操作的源文件与完整文件上下文不一致");
  }
  if (operation === "delete") {
    if (!exactKeys(args, ["operation", "path"])) {
      throw new Error("AI 返回了无效的删除文件参数");
    }
    return {
      id: call.id,
      operation,
      originalFile: { ...originalFile },
      path,
      sessionId,
      status: "pending",
    };
  }

  if (!exactKeys(args, ["operation", "path", "target_path"])) {
    throw new Error("AI 返回了无效的重命名参数");
  }
  if (typeof args.target_path !== "string") {
    throw new Error("AI 返回的重命名目标无效");
  }
  const targetPath = normalizeAiRemotePath(args.target_path);
  if (
    targetPath === "/" ||
    targetPath === path ||
    aiRemoteParentPath(targetPath) !== aiRemoteParentPath(path)
  ) {
    throw new Error("AI 重命名目标必须与源文件位于同一目录");
  }
  if (availableFiles.some((file) => file.path === targetPath)) {
    throw new Error("AI 重命名目标与已选择文件冲突");
  }
  return {
    id: call.id,
    operation,
    originalFile: { ...originalFile },
    path,
    sessionId,
    status: "pending",
    targetPath,
  };
}

function matchesOperation(value: unknown): value is AiFileOperationKind {
  return value === "create" || value === "rename" || value === "delete";
}

export function aiFileOperationToolResult(
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
            message: "文件操作提案已记录，正在等待用户审阅，尚未执行",
          },
    ),
  };
}

export function aiFileOperationLineSummary(
  proposal: AiFileOperationProposal,
) {
  if (proposal.operation === "create") {
    return aiFileEditLineSummary("", proposal.content ?? "");
  }
  if (proposal.operation === "delete") {
    return aiFileEditLineSummary(proposal.originalFile?.content ?? "", "");
  }
  return { addedLines: 0, removedLines: 0 };
}

export function markAiFileOperationApplied(
  proposal: AiFileOperationProposal,
  result: AiFileOperationResult,
  appliedAt: string,
) {
  const expectedPath =
    proposal.operation === "rename" ? proposal.targetPath : proposal.path;
  const expectedContent =
    proposal.operation === "create"
      ? proposal.content
      : proposal.originalFile?.content;
  if (proposal.operation === "delete") {
    if (result.file) throw new Error("删除文件操作返回了无效结果");
  } else if (
    !result.file ||
    result.file.path !== expectedPath ||
    result.file.content !== expectedContent
  ) {
    throw new Error("远程文件操作结果与提案不一致");
  }
  return {
    ...proposal,
    appliedAt,
    appliedFile: result.file ? { ...result.file } : undefined,
    error: undefined,
    rollbackError: undefined,
    rolledBackAt: undefined,
    status: "applied" as const,
  };
}

export function aiFileOperationRollbackEligibilityError(
  proposal: AiFileOperationProposal,
) {
  if (proposal.status !== "applied") {
    return "当前文件操作没有可回滚的应用快照";
  }
  if (
    proposal.operation !== "delete" &&
    (!proposal.appliedFile ||
      proposal.appliedFile.path !==
        (proposal.operation === "rename" ? proposal.targetPath : proposal.path))
  ) {
    return "文件操作应用快照无效";
  }
  if (proposal.operation !== "create" && !proposal.originalFile) {
    return "文件操作原始快照无效";
  }
  return null;
}

export function aiFileOperationApplyRequest(
  proposal: AiFileOperationProposal,
): AiFileOperationExecutionRequest {
  if (proposal.operation === "create") {
    const contentError = aiFileOperationContentError(proposal.content ?? "");
    if (contentError) throw new Error(contentError);
    return {
      content: proposal.content ?? "",
      operation: "create",
      path: proposal.path,
    };
  }
  if (!proposal.originalFile) throw new Error("文件操作原始快照无效");
  if (proposal.operation === "rename") {
    if (!proposal.targetPath) throw new Error("重命名目标路径无效");
    return {
      expectedContent: proposal.originalFile.content,
      operation: "rename",
      path: proposal.path,
      targetPath: proposal.targetPath,
    };
  }
  return {
    expectedContent: proposal.originalFile.content,
    operation: "delete",
    path: proposal.path,
  };
}

export function aiFileOperationRollbackRequest(
  proposal: AiFileOperationProposal,
): AiFileOperationExecutionRequest {
  const error = aiFileOperationRollbackEligibilityError(proposal);
  if (error) throw new Error(error);
  if (proposal.operation === "create") {
    return {
      expectedContent: proposal.appliedFile!.content,
      operation: "delete",
      path: proposal.path,
    };
  }
  if (proposal.operation === "rename") {
    return {
      expectedContent: proposal.appliedFile!.content,
      operation: "rename",
      path: proposal.targetPath!,
      targetPath: proposal.path,
    };
  }
  return {
    content: proposal.originalFile!.content,
    operation: "create",
    path: proposal.path,
  };
}

export function markAiFileOperationRolledBack(
  proposal: AiFileOperationProposal,
  rolledBackAt: string,
) {
  const error = aiFileOperationRollbackEligibilityError(proposal);
  if (error) throw new Error(error);
  return {
    ...proposal,
    error: undefined,
    rollbackError: undefined,
    rolledBackAt,
    status: "rolled-back" as const,
  };
}

export function aiFileOperationLabel(operation: AiFileOperationKind) {
  if (operation === "create") return "新建文件";
  if (operation === "rename") return "重命名文件";
  return "删除文件";
}

export function aiFileOperationDisplayName(
  proposal: AiFileOperationProposal,
) {
  return aiRemoteFileName(
    proposal.operation === "rename" ? proposal.targetPath ?? proposal.path : proposal.path,
  );
}
