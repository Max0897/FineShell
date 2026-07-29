import { describe, expect, test } from "bun:test";
import contract from "../protocol/contract.json";
import {
  FineShellCommandError,
  PROTOCOL_VERSION,
  normalizeCommandError,
  type AgentActionRisk,
  type AgentApprovalMode,
  type AgentPlanStepStatus,
  type AgentPlanStatus,
  type AgentTaskEventKind,
  type AgentTaskStatus,
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
    expect(Object.keys(contract.commands)).toHaveLength(73);
    expect(Object.keys(contract.events)).toHaveLength(11);
  });

  test("exposes canonical agent lifecycle values", () => {
    const status: AgentTaskStatus = "awaiting_approval";
    const event: AgentTaskEventKind = "model_turn_completed";
    const step: AgentPlanStepStatus = "in_progress";
    const plan: AgentPlanStatus = "partial";
    const approval: AgentApprovalMode = "on_request";
    const risk: AgentActionRisk = "reversible_write";

    expect(contract.agentTaskStatuses[status]).toBe(true);
    expect(contract.agentTaskEventKinds[event]).toBe(true);
    expect(contract.agentPlanStepStatuses[step]).toBe(true);
    expect(contract.agentPlanStatuses[plan]).toBe(true);
    expect(contract.agentApprovalModes[approval]).toBe(true);
    expect(contract.agentActionRisks[risk]).toBe(true);
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
    const missingSession = normalizeCommandError(
      "ssh_write",
      "SSH 会话未连接",
    );

    expect(timeout.code).toBe("timeout");
    expect(timeout.retryable).toBe(true);
    expect(String(timeout)).toBe("SSH 连接超时");
    expect(missingSession.code).toBe("not_connected");
  });
});
