import { describe, expect, test } from "bun:test";
import contract from "../protocol/contract.json";
import {
  FineShellCommandError,
  PROTOCOL_VERSION,
  normalizeCommandError,
  type AgentActionStatus,
  type AgentActionTransition,
  type AgentActionRisk,
  type AgentCommandExecutionPhase,
  type AgentApprovalMode,
  type AgentPlanStepStatus,
  type AgentPlanStatus,
  type AgentRepairStopReason,
  type AgentRecoveryRecommendation,
  type AgentRecoveryStatus,
  type AgentTaskEventKind,
  type AgentTaskStatus,
  type AgentVerificationEvidenceKind,
  type AgentVerificationStatus,
  type TauriCommand,
  type TauriEvent,
} from "./tauri-protocol";

describe("Tauri shared protocol", () => {
  test("exposes the canonical version, commands, and events", () => {
    const command: TauriCommand = "ssh_connect";
    const event: TauriEvent = "menu-select-all";

    expect(PROTOCOL_VERSION).toBe(contract.version);
    expect(contract.commands[command]).toBe(true);
    expect(contract.events[event]).toBe(true);
    expect(Object.keys(contract.commands)).toHaveLength(103);
    expect(Object.keys(contract.events)).toHaveLength(11);
  });

  test("exposes canonical agent lifecycle values", () => {
    const status: AgentTaskStatus = "awaiting_approval";
    const disconnectedStatus: AgentTaskStatus = "paused_disconnected";
    const event: AgentTaskEventKind = "model_turn_completed";
    const resumedEvent: AgentTaskEventKind = "task_resumed";
    const step: AgentPlanStepStatus = "in_progress";
    const plan: AgentPlanStatus = "partial";
    const approval: AgentApprovalMode = "on_request";
    const risk: AgentActionRisk = "reversible_write";
    const actionStatus: AgentActionStatus = "running";
    const actionTransition: AgentActionTransition = "rollback_start";
    const commandPhase: AgentCommandExecutionPhase = "interrupted";
    const verification: AgentVerificationStatus = "unverified";
    const evidence: AgentVerificationEvidenceKind = "service_status";
    const repairStop: AgentRepairStopReason = "repair_budget_exhausted";
    const recovery: AgentRecoveryRecommendation = "rollback";
    const recoveryStatus: AgentRecoveryStatus = "verified";

    expect(contract.agentTaskStatuses[status]).toBe(true);
    expect(contract.agentTaskStatuses[disconnectedStatus]).toBe(true);
    expect(contract.agentTaskEventKinds[event]).toBe(true);
    expect(contract.agentTaskEventKinds[resumedEvent]).toBe(true);
    expect(contract.agentPlanStepStatuses[step]).toBe(true);
    expect(contract.agentPlanStatuses[plan]).toBe(true);
    expect(contract.agentApprovalModes[approval]).toBe(true);
    expect(contract.agentActionRisks[risk]).toBe(true);
    expect(contract.agentActionStatuses[actionStatus]).toBe(true);
    expect(contract.agentActionTransitions[actionTransition]).toBe(true);
    expect(contract.agentCommandExecutionPhases[commandPhase]).toBe(true);
    expect(contract.agentVerificationStatuses[verification]).toBe(true);
    expect(contract.agentVerificationEvidenceKinds[evidence]).toBe(true);
    expect(contract.agentRepairStopReasons[repairStop]).toBe(true);
    expect(contract.agentRecoveryRecommendations[recovery]).toBe(true);
    expect(contract.agentRecoveryStatuses[recoveryStatus]).toBe(true);
  });

  test("preserves structured backend errors", () => {
    const error = normalizeCommandError("read_config_file", {
      code: "permission_denied",
      message: "无法读取配置文件：Permission denied",
      operation: "read_config_file",
      retryable: false,
    });

    expect(error).toBeInstanceOf(FineShellCommandError);
    expect(error.code).toBe("permission_denied");
    expect(error.message).toBe("无法读取配置文件：Permission denied");
    expect(error.operation).toBe("read_config_file");
    expect(error.retryable).toBe(false);
  });

  test("normalizes legacy string errors during incremental migration", () => {
    const timeout = normalizeCommandError("ssh_connect", "SSH 连接超时");
    const missingSession = normalizeCommandError("ssh_write", "SSH 会话未连接");

    expect(timeout.code).toBe("timeout");
    expect(timeout.retryable).toBe(true);
    expect(String(timeout)).toBe("SSH 连接超时");
    expect(missingSession.code).toBe("not_connected");
  });
});
