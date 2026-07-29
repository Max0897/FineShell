import { normalizeAiRemotePath } from "./ai-file-operations";
import { normalizeAiCommandVerification } from "./ai-command-proposals";
import { normalizeAiTerminalCommand } from "./ai-utils";
import type {
  AgentActionIntent,
  AgentActionRisk,
  AiToolCall,
} from "./tauri-protocol";

const PROPOSAL_TOOLS = new Set([
  "propose_file_edit",
  "propose_file_operation",
  "propose_terminal_command",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function parseArguments(call: AiToolCall) {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error("AI 动作参数不是有效 JSON");
  }
  if (!isRecord(value)) throw new Error("AI 动作参数必须是对象");
  return value;
}

function normalizedCallArguments(call: AiToolCall): {
  arguments: Record<string, unknown>;
  risk: AgentActionRisk;
} {
  const value = parseArguments(call);
  if (call.name === "propose_file_edit") {
    if (
      !exactKeys(value, ["path", "content"]) ||
      typeof value.path !== "string" ||
      typeof value.content !== "string"
    ) {
      throw new Error("AI 文件修改动作参数无效");
    }
    return {
      arguments: {
        path: normalizeAiRemotePath(value.path),
        content: value.content,
      },
      risk: "reversible_write",
    };
  }
  if (call.name === "propose_file_operation") {
    if (typeof value.operation !== "string" || typeof value.path !== "string") {
      throw new Error("AI 文件操作动作参数无效");
    }
    const path = normalizeAiRemotePath(value.path);
    if (value.operation === "create") {
      if (!exactKeys(value, ["operation", "path", "content"]) ||
        typeof value.content !== "string") {
        throw new Error("AI 新建文件动作参数无效");
      }
      return {
        arguments: { operation: value.operation, path, content: value.content },
        risk: "reversible_write",
      };
    }
    if (value.operation === "rename") {
      if (!exactKeys(value, ["operation", "path", "target_path"]) ||
        typeof value.target_path !== "string") {
        throw new Error("AI 重命名文件动作参数无效");
      }
      return {
        arguments: {
          operation: value.operation,
          path,
          targetPath: normalizeAiRemotePath(value.target_path),
        },
        risk: "reversible_write",
      };
    }
    if (value.operation === "delete" &&
      exactKeys(value, ["operation", "path"])) {
      return {
        arguments: { operation: value.operation, path },
        risk: "elevated",
      };
    }
    throw new Error("AI 文件操作动作参数无效");
  }
  if (call.name === "propose_terminal_command") {
    if ((!exactKeys(value, ["command", "purpose"]) &&
      !exactKeys(value, ["command", "purpose", "verification"])) ||
      typeof value.command !== "string" ||
      typeof value.purpose !== "string") {
      throw new Error("AI 终端命令动作参数无效");
    }
    const normalizedArguments: Record<string, unknown> = {
      command: normalizeAiTerminalCommand(value.command),
      purpose: value.purpose.trim().replace(/\s+/g, " "),
    };
    if (value.verification !== undefined) {
      normalizedArguments.verification = normalizeAiCommandVerification(
        value.verification,
      );
    }
    return {
      arguments: normalizedArguments,
      risk: "elevated",
    };
  }
  throw new Error("AI 返回了不支持的动作工具");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateAiActionIntents(
  calls: AiToolCall[],
  intents: AgentActionIntent[],
) {
  const proposalCalls = calls.filter((call) => PROPOSAL_TOOLS.has(call.name));
  if (proposalCalls.length !== intents.length) {
    throw new Error("AI 动作意图与提案数量不一致");
  }
  const callsById = new Map(proposalCalls.map((call) => [call.id, call]));
  const seen = new Set<string>();
  for (const intent of intents) {
    if (seen.has(intent.id)) throw new Error("AI 动作意图包含重复标识");
    seen.add(intent.id);
    const call = callsById.get(intent.id);
    if (!call || call.name !== intent.tool) {
      throw new Error("AI 动作意图与提案不匹配");
    }
    const normalized = normalizedCallArguments(call);
    if (
      normalized.risk !== intent.risk ||
      canonicalJson(normalized.arguments) !== canonicalJson(intent.arguments) ||
      !intent.reason.trim() ||
      !intent.expectedEffect.trim()
    ) {
      throw new Error("AI 动作意图未通过可信校验");
    }
  }
}
