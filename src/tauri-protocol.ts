import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  emitTo,
  listen,
  type Event,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import contract from "../protocol/contract.json";
import type { AppSettings } from "./app-settings";
import type { PortForwardStatus } from "./models";
import type { SftpTransferStatus } from "./sftp-utils";

export const PROTOCOL_VERSION = contract.version;

export type TauriCommand = keyof typeof contract.commands;
export type TauriEvent = keyof typeof contract.events;
export type CommandErrorCode = keyof typeof contract.errorCodes;
export type AgentTaskStatus = keyof typeof contract.agentTaskStatuses;
export type AgentTaskEventKind = keyof typeof contract.agentTaskEventKinds;
export type AgentPlanStepStatus = keyof typeof contract.agentPlanStepStatuses;
export type AgentPlanStatus = keyof typeof contract.agentPlanStatuses;
export type AgentApprovalMode = keyof typeof contract.agentApprovalModes;
export type AgentActionRisk = keyof typeof contract.agentActionRisks;
export type AgentActionStatus = keyof typeof contract.agentActionStatuses;
export type AgentActionTransition = keyof typeof contract.agentActionTransitions;
export type AgentVerificationStatus = keyof typeof contract.agentVerificationStatuses;
export type AgentVerificationEvidenceKind =
  keyof typeof contract.agentVerificationEvidenceKinds;
export type AgentRepairStopReason = keyof typeof contract.agentRepairStopReasons;

export interface CommandErrorPayload {
  code: CommandErrorCode;
  message: string;
  retryable: boolean;
  operation: TauriCommand;
  context?: Record<string, unknown>;
}

export interface ProtocolVersionResult {
  version: number;
}

export interface SshConnectResult {
  status: "connected" | "hostKeyVerificationRequired";
  fingerprint: string;
  expectedFingerprint: string | null;
  portForwards: PortForwardStatus[];
}

export interface SshOutputPayload {
  sessionId: string;
  data: string;
}

export interface SshStatusPayload {
  sessionId: string;
  status: "disconnected";
  error?: string;
  recoverable: boolean;
}

export interface PortForwardStatusPayload extends PortForwardStatus {
  sessionId: string;
}

export interface SftpTransferPayload {
  sessionId: string;
  transferId: string;
  direction: "upload" | "download";
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  status: Exclude<SftpTransferStatus, "queued">;
  error?: string;
}

export type ExternalEditStatus =
  | "watching"
  | "syncing"
  | "synced"
  | "conflict"
  | "failed"
  | "closed";

export interface ExternalEditPayload {
  editId: string;
  sessionId: string;
  remotePath: string;
  fileName: string;
  localPath: string;
  status: ExternalEditStatus;
  error?: string;
  updatedAt?: number;
}

export interface ExternalEditResult {
  editId: string;
  localPath: string;
}

export interface MenuSelectAllPayload {
  invert: boolean;
}

export interface AiStreamPayload {
  requestId: string;
  delta: string;
}

export interface AiCompletePayload {
  requestId: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  tool: string;
  status: AgentPlanStepStatus;
  detail: string | null;
  reason: string;
  optional: boolean;
  dependsOn: string[];
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  durationMs: number | null;
}

export interface AgentPlan {
  id: string;
  description: string | null;
  status: AgentPlanStatus;
  createdAt: number;
  steps: AgentPlanStep[];
}

export interface AgentActionIntent {
  id: string;
  tool: string;
  arguments: unknown;
  reason: string;
  expectedEffect: string;
  risk: AgentActionRisk;
}

export interface AgentActionState {
  id: string;
  tool: string;
  reason: string;
  expectedEffect: string;
  risk: AgentActionRisk;
  status: AgentActionStatus;
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  verificationStatus: AgentVerificationStatus;
  verificationEvidence: AgentVerificationEvidence[];
}

export interface AgentVerificationEvidence {
  kind: AgentVerificationEvidenceKind;
  summary: string;
  observedAt: number;
}

export interface AgentActionTransitionRequest {
  taskId: string;
  actionId: string;
  transition: AgentActionTransition;
  summary?: string;
  error?: string;
}

export interface AgentCommandObservationRequest {
  taskId: string;
  actionId: string;
  hostId: string;
  sessionId: string;
  submissionId: string;
  phase: "submitted" | "completed" | "unavailable";
  command: string;
  exitCode?: number;
  durationMs?: number;
  reason?: string;
}

export interface AgentActionExecutionResult {
  actionId: string;
  actionType: "file_edit" | "file_operation" | "terminal_command";
  file: {
    path: string;
    content: string;
    size: number;
    modifiedAt: number | null;
    permissions: number | null;
  } | null;
  affectedPaths: string[];
}

export interface AgentTaskResult {
  summary: string;
  verified: boolean;
  verificationStatus: AgentVerificationStatus;
  stopReason: string | null;
}

export interface AgentTaskContext {
  id: string;
  conversationId: string;
  hostId: string;
  terminalSessionId?: string;
  currentDirectory?: string;
  fileOperationDirectory?: string;
  writableFiles: Array<{
    path: string;
    content: string;
    size: number;
  }>;
  objective: string;
  approvalMode: AgentApprovalMode;
}

export interface AgentTask {
  id: string;
  conversationId: string;
  hostId: string;
  terminalSessionId: string | null;
  currentDirectory: string | null;
  approvalMode: AgentApprovalMode;
  status: AgentTaskStatus;
  objective: string;
  plan: AgentPlan | null;
  activeStepId: string | null;
  actions: AgentActionState[];
  modelCompleted: boolean;
  iteration: number;
  repairAttempts: number;
  repairLimit: number;
  repairStopReason: AgentRepairStopReason | null;
  lastEventSequence: number;
  result: AgentTaskResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTaskEventPayload {
  protocolVersion: number;
  sequence: number;
  kind: AgentTaskEventKind;
  actionId?: string;
  task: AgentTask;
}

export interface AiChatResult {
  content: string;
  toolCalls: AiToolCall[];
  actionIntents?: AgentActionIntent[];
  diagnosticPlans?: AgentPlan[];
  diagnosticToolRounds?: AiToolRound[];
}

export type AiFinalizeReason =
  | "tool_budget"
  | "no_progress"
  | "consecutive_failures";

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiToolResult {
  callId: string;
  name: string;
  content: string;
}

export interface AiToolRound {
  calls: AiToolCall[];
  content?: string;
  results: AiToolResult[];
}

export interface AiModelInfo {
  id: string;
  ownedBy?: string;
}

export type AiCapabilityState = "supported" | "unsupported" | "unknown";

export interface AiCapability {
  state: AiCapabilityState;
  detail: string;
}

export interface AiServiceCapabilities {
  chat: AiCapability;
  models: AiCapability;
  streaming: AiCapability;
  tools: AiCapability;
}

interface EventPayloadMap {
  "ssh-output": SshOutputPayload;
  "ssh-status": SshStatusPayload;
  "port-forward-status": PortForwardStatusPayload;
  "sftp-transfer": SftpTransferPayload;
  "sftp-external-edit": ExternalEditPayload;
  "ai-stream": AiStreamPayload;
  "ai-complete": AiCompletePayload;
  "ai-task": AgentTaskEventPayload;
  "configuration:changed": undefined;
  "settings:changed": AppSettings;
  "menu-select-all": MenuSelectAllPayload;
}

const ERROR_CODES = new Set<CommandErrorCode>(
  Object.keys(contract.errorCodes) as CommandErrorCode[],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyLegacyError(message: string): {
  code: CommandErrorCode;
  retryable: boolean;
} {
  const normalized = message.toLowerCase();
  if (/取消|cancel/.test(normalized)) {
    return { code: "cancelled", retryable: false };
  }
  if (/超时|timed? out|timeout/.test(normalized)) {
    return { code: "timeout", retryable: true };
  }
  if (/权限|permission denied|access denied/.test(normalized)) {
    return { code: "permission_denied", retryable: false };
  }
  if (/指纹|host key/.test(normalized)) {
    return { code: "host_key_verification_failed", retryable: false };
  }
  if (/认证|密码|口令|authentication|no identities/.test(normalized)) {
    return { code: "authentication_failed", retryable: false };
  }
  if (/未连接|不存在会话|not connected|session.*not found/.test(normalized)) {
    return { code: "not_connected", retryable: true };
  }
  if (/不存在|未找到|not found|no such file/.test(normalized)) {
    return { code: "not_found", retryable: false };
  }
  if (/冲突|已被其他程序修改|conflict/.test(normalized)) {
    return { code: "conflict", retryable: false };
  }
  if (/不支持|unsupported/.test(normalized)) {
    return { code: "unsupported", retryable: false };
  }
  if (/不能为空|无效|invalid|超过.*限制/.test(normalized)) {
    return { code: "invalid_request", retryable: false };
  }
  if (/连接失败|connection (failed|refused|reset)|无法连接/.test(normalized)) {
    return { code: "connection_failed", retryable: true };
  }
  if (/无法读取|无法写入|无法创建|i\/o|os error/.test(normalized)) {
    return { code: "io", retryable: false };
  }
  return { code: "internal", retryable: false };
}

export class FineShellCommandError extends Error {
  readonly code: CommandErrorCode;
  readonly retryable: boolean;
  readonly operation: TauriCommand;
  readonly context?: Record<string, unknown>;

  constructor(payload: CommandErrorPayload) {
    super(payload.message);
    this.name = "FineShellCommandError";
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.operation = payload.operation;
    this.context = payload.context;
  }

  toJSON(): CommandErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      operation: this.operation,
      context: this.context,
    };
  }

  toString() {
    return this.message;
  }
}

export function normalizeCommandError(
  operation: TauriCommand,
  error: unknown,
): FineShellCommandError {
  if (error instanceof FineShellCommandError) return error;
  if (isRecord(error)) {
    const code = error.code;
    const message = error.message;
    if (
      typeof code === "string" &&
      ERROR_CODES.has(code as CommandErrorCode) &&
      typeof message === "string"
    ) {
      return new FineShellCommandError({
        code: code as CommandErrorCode,
        message,
        retryable: error.retryable === true,
        operation:
          typeof error.operation === "string" &&
          error.operation in contract.commands
            ? (error.operation as TauriCommand)
            : operation,
        context: isRecord(error.context) ? error.context : undefined,
      });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FineShellCommandError({
    ...classifyLegacyError(message),
    message,
    operation,
  });
}

export function commandErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function invokeProtocolCommand<T = void>(
  command: TauriCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeCommandError(command, error);
  }
}

export function listenProtocolEvent<E extends TauriEvent>(
  event: E,
  handler: (event: Event<EventPayloadMap[E]>) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloadMap[E]>(event, handler);
}

export function emitProtocolEventTo<E extends TauriEvent>(
  target: string,
  event: E,
  ...payload: EventPayloadMap[E] extends undefined
    ? []
    : [payload: EventPayloadMap[E]]
) {
  return emitTo(target, event, payload[0]);
}

export async function verifyProtocolVersion() {
  const result = await invokeProtocolCommand<ProtocolVersionResult>(
    "protocol_version",
  );
  if (result.version !== PROTOCOL_VERSION) {
    throw new FineShellCommandError({
      code: "unsupported",
      message: `前后端协议版本不一致（前端 ${PROTOCOL_VERSION}，后端 ${result.version}）`,
      operation: "protocol_version",
      retryable: false,
    });
  }
  return result;
}
