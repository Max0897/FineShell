import type { AiDiagnosticPlan } from "../ai-diagnostic-plans";
import { isAiReadOnlyToolName, type AiToolRun } from "../ai-tools";
import type { AgentPlan, AgentTask } from "../tauri-protocol";
import type { AiMessage } from "./useAiConversations";

export function agentTaskIsTerminal(task: AgentTask) {
  return ["completed", "failed", "cancelled"].includes(task.status);
}

function agentPlanPresentation(plan: AgentPlan): {
  plan: AiDiagnosticPlan;
  runs: AiToolRun[];
} {
  const runs = plan.steps
    .filter((step) => isAiReadOnlyToolName(step.tool))
    .map((step): AiToolRun => {
      const status: AiToolRun["status"] =
        step.status === "in_progress"
          ? "running"
          : step.status === "completed"
            ? "success"
            : step.status === "failed"
              ? "failed"
              : step.status === "skipped"
                ? "skipped"
                : "pending";
      return {
        callId: step.id,
        dependsOn: step.dependsOn.length ? step.dependsOn : undefined,
        detail: step.detail ?? undefined,
        durationMs: step.durationMs ?? undefined,
        error: step.error ?? undefined,
        label: step.title,
        name: step.tool as AiToolRun["name"],
        optional: step.optional || undefined,
        planId: plan.id,
        reason: step.reason,
        startedAt: step.startedAt ?? plan.createdAt,
        status,
        summary: step.summary ?? undefined,
      };
    });

  return {
    plan: {
      createdAt: new Date(plan.createdAt).toISOString(),
      description: plan.description ?? undefined,
      id: plan.id,
      status: plan.status,
      stepCallIds: plan.steps.map((step) => step.id),
    },
    runs,
  };
}

export function mergeAgentPlanIntoMessage(
  message: AiMessage,
  plan: AgentPlan,
): AiMessage {
  const presentation = agentPlanPresentation(plan);
  const diagnosticPlans = message.diagnosticPlans ?? [];
  const toolRuns = message.toolRuns ?? [];
  const planExists = diagnosticPlans.some((item) => item.id === plan.id);
  const nextPlanCallIds = new Set(presentation.runs.map((run) => run.callId));

  return {
    ...message,
    diagnosticPlans: planExists
      ? diagnosticPlans.map((item) =>
          item.id === plan.id ? presentation.plan : item,
        )
      : [...diagnosticPlans, presentation.plan],
    toolRuns: [
      ...toolRuns.filter((run) => !nextPlanCallIds.has(run.callId)),
      ...presentation.runs,
    ],
  };
}
