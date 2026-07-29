import type { AiToolRun } from "./ai-tools";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSafeText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? redactAiContext(value.trim()).slice(0, maxLength)
    : undefined;
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
