import type { AiCommandProposal } from "./ai-command-proposals";
import type { AiDiagnosticPlan } from "./ai-diagnostic-plans";
import type { AiFileEditProposal } from "./ai-file-edits";
import type { AiFileOperationProposal } from "./ai-file-operations";
import type { AiToolRun } from "./ai-tools";
import type { AgentApprovalMode } from "./tauri-protocol";

interface AiApprovalMessage {
  commandProposals?: AiCommandProposal[];
  diagnosticPlans?: AiDiagnosticPlan[];
  fileEditProposals?: AiFileEditProposal[];
  fileOperationProposals?: AiFileOperationProposal[];
  id: string;
  taskId?: string;
  toolRuns?: AiToolRun[];
}

export type AiApprovalQueueItem =
  | {
      kind: "command";
      messageId: string;
      proposal: AiCommandProposal;
    }
  | {
      kind: "diagnostic";
      messageId: string;
      plan: AiDiagnosticPlan;
      runs: AiToolRun[];
    }
  | {
      kind: "file-edit";
      messageId: string;
      proposal: AiFileEditProposal;
    }
  | {
      kind: "file-operation";
      messageId: string;
      proposal: AiFileOperationProposal;
    };

export function aiApprovalRequiresUserDecision(
  item: AiApprovalQueueItem,
  mode: AgentApprovalMode,
) {
  if (mode === "on_request" || item.kind === "diagnostic") return true;
  if (mode === "full_access") return false;
  return item.kind !== "command" || item.proposal.assessment.risk !== "safe";
}

const BLOCKING_COMMAND_STATUSES = new Set<AiCommandProposal["status"]>([
  "pending",
  "approved",
  "executed",
]);

export function buildAiApprovalQueue(
  messages: AiApprovalMessage[],
  taskId: string | undefined,
  active: boolean,
  pendingDiagnosticPlanId?: string,
): AiApprovalQueueItem[] {
  if (!active) return [];
  const taskMessages = taskId
    ? messages.filter((message) => message.taskId === taskId)
    : messages.slice(-1);

  return taskMessages.flatMap((message) => {
    const diagnosticApprovals: AiApprovalQueueItem[] = (
      message.diagnosticPlans ?? []
    )
      .filter(
        (plan) =>
          plan.status === "pending" && plan.id === pendingDiagnosticPlanId,
      )
      .map((plan) => ({
        kind: "diagnostic" as const,
        messageId: message.id,
        plan,
        runs: (message.toolRuns ?? []).filter(
          (run) => run.planId === plan.id,
        ),
      }));
    const commandApprovals: AiApprovalQueueItem[] = (
      message.commandProposals ?? []
    )
      .filter((proposal) => BLOCKING_COMMAND_STATUSES.has(proposal.status))
      .map((proposal) => ({
        kind: "command" as const,
        messageId: message.id,
        proposal,
      }));
    const fileEditApprovals: AiApprovalQueueItem[] = (
      message.fileEditProposals ?? []
    )
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => ({
        kind: "file-edit" as const,
        messageId: message.id,
        proposal,
      }));
    const fileOperationApprovals: AiApprovalQueueItem[] = (
      message.fileOperationProposals ?? []
    )
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => ({
        kind: "file-operation" as const,
        messageId: message.id,
        proposal,
      }));
    return [
      ...diagnosticApprovals,
      ...commandApprovals,
      ...fileEditApprovals,
      ...fileOperationApprovals,
    ];
  });
}
