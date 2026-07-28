import type { AiReadOnlyToolName } from "./ai-permissions";
import { aiReadOnlyToolEnabled, isAiReadOnlyToolName } from "./ai-permissions";
import {
  aiToolLabel,
  aiToolRequiresConfirmation,
  aiToolTarget,
  createAiToolRun,
  type AiToolRun,
} from "./ai-tools";
import type { AiToolCall } from "./tauri-protocol";
import { redactAiContext } from "./ai-utils";

export const MAX_AI_DIAGNOSTIC_PLAN_STEPS = 6;

export type AiDiagnosticPlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "cancelled";

export interface AiDiagnosticPlan {
  createdAt: string;
  description?: string;
  id: string;
  status: AiDiagnosticPlanStatus;
  stepCallIds: string[];
  stopRequested?: boolean;
}

interface DiagnosticStepMetadata {
  dependsOnIndexes: number[];
  optional: boolean;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSafeText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? redactAiContext(value.trim()).slice(0, maxLength)
    : undefined;
}

function parseArguments(call: AiToolCall) {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error(`AI 返回了无效的工具参数：${call.name}`);
  }
  if (!isRecord(value)) {
    throw new Error(`AI 返回了无效的工具参数：${call.name}`);
  }
  return value;
}

function stepMetadata(call: AiToolCall, index: number): DiagnosticStepMetadata {
  const argumentsValue = parseArguments(call);
  const reason =
    boundedSafeText(argumentsValue.reason, 240) ??
    `${aiToolLabel(call.name)}${aiToolTarget(call) ? ` ${aiToolTarget(call)}` : ""}`;
  if (
    argumentsValue.optional !== undefined &&
    typeof argumentsValue.optional !== "boolean"
  ) {
    throw new Error("AI 返回了无效的诊断步骤可选状态");
  }
  const dependencyValues = argumentsValue.depends_on;
  if (dependencyValues !== undefined && !Array.isArray(dependencyValues)) {
    throw new Error("AI 返回了无效的诊断步骤依赖");
  }
  const dependsOnIndexes = Array.isArray(dependencyValues)
    ? Array.from(new Set(dependencyValues)).map((dependency) => {
        if (
          typeof dependency !== "number" ||
          !Number.isInteger(dependency) ||
          dependency < 1 ||
          dependency > index
        ) {
          throw new Error("诊断步骤只能依赖此前的计划步骤");
        }
        return dependency - 1;
      })
    : [];
  return {
    dependsOnIndexes,
    optional: argumentsValue.optional === true,
    reason,
  };
}

function callIdentity(call: AiToolCall) {
  return `${call.name}:${aiToolTarget(call)?.toLowerCase() ?? ""}`;
}

export function createAiDiagnosticPlan(
  id: string,
  calls: AiToolCall[],
  description: string,
  enabledTools: readonly AiReadOnlyToolName[],
  startedAt = Date.now(),
): { plan: AiDiagnosticPlan; runs: AiToolRun[] } {
  if (!calls.length || calls.length > MAX_AI_DIAGNOSTIC_PLAN_STEPS) {
    throw new Error(`单个诊断计划最多包含 ${MAX_AI_DIAGNOSTIC_PLAN_STEPS} 个步骤`);
  }
  const identities = new Set<string>();
  const metadata = calls.map((call, index) => {
    if (!isAiReadOnlyToolName(call.name)) {
      throw new Error(`AI 请求了不支持的工具：${call.name}`);
    }
    const identity = callIdentity(call);
    if (identities.has(identity)) {
      throw new Error("诊断计划包含重复步骤");
    }
    identities.add(identity);
    return stepMetadata(call, index);
  });
  const runs = calls.map((call, index) => {
    const run = createAiToolRun(call, startedAt, "pending");
    const step = metadata[index]!;
    return {
      ...run,
      dependsOn: step.dependsOnIndexes.map(
        (dependencyIndex) => calls[dependencyIndex]!.id,
      ),
      optional: step.optional || undefined,
      planId: id,
      reason: step.reason,
      status: aiReadOnlyToolEnabled(enabledTools, call.name)
        ? ("pending" as const)
        : ("unavailable" as const),
      ...(aiToolRequiresConfirmation(call.name)
        ? { summary: "确认计划即授权执行此主动网络探测" }
        : {}),
    };
  });
  return {
    plan: {
      createdAt: new Date(startedAt).toISOString(),
      description: boundedSafeText(description, 2_000),
      id,
      status: runs.some((run) => run.status === "pending")
        ? "pending"
        : "partial",
      stepCallIds: calls.map((call) => call.id),
    },
    runs,
  };
}

export function completeAiDiagnosticPlan(
  plan: AiDiagnosticPlan,
  runs: AiToolRun[],
): AiDiagnosticPlan {
  const steps = runs.filter((run) => run.planId === plan.id);
  const successes = steps.filter((run) => run.status === "success").length;
  const cancelled = steps.every(
    (run) => run.status === "cancelled" || run.status === "unavailable",
  );
  const completed = steps.every(
    (run) => run.status === "success" || (run.optional && run.status === "cancelled"),
  );
  return {
    ...plan,
    status: cancelled
      ? "cancelled"
      : completed
        ? "completed"
        : successes || steps.some((run) => run.status === "failed")
          ? "partial"
          : "cancelled",
    stopRequested: undefined,
  };
}

export function sanitizePersistedAiDiagnosticPlans(
  value: unknown,
): AiDiagnosticPlan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const plans = value
    .map((item): AiDiagnosticPlan | undefined => {
      if (!isRecord(item)) return undefined;
      const id = boundedSafeText(item.id, 160);
      const createdAt = boundedSafeText(item.createdAt, 40);
      const status = item.status;
      if (
        !id ||
        !createdAt ||
        !Number.isFinite(Date.parse(createdAt)) ||
        (status !== "completed" &&
          status !== "partial" &&
          status !== "cancelled") ||
        !Array.isArray(item.stepCallIds)
      ) {
        return undefined;
      }
      const stepCallIds = Array.from(
        new Set(
          item.stepCallIds
            .map((callId) => boundedSafeText(callId, 160))
            .filter((callId): callId is string => Boolean(callId)),
        ),
      ).slice(0, MAX_AI_DIAGNOSTIC_PLAN_STEPS);
      if (!stepCallIds.length) return undefined;
      return {
        createdAt: new Date(createdAt).toISOString(),
        description: boundedSafeText(item.description, 2_000),
        id,
        status,
        stepCallIds,
      };
    })
    .filter((plan): plan is AiDiagnosticPlan => Boolean(plan))
    .slice(-3);
  return plans.length ? plans : undefined;
}
