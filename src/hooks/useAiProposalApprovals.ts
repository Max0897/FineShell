import { useCallback, useRef } from "react";
import type { AiCommandApprovalDecision } from "../ai-command-proposals";
import type { AiFileApprovalDecision } from "../ai-file-approvals";

interface PendingApproval<TDecision> {
  reject: (error: Error) => void;
  requestId: string;
  resolve: (decision: TDecision) => void;
}

function rejectApprovalsForRequest<TDecision>(
  approvals: Map<string, PendingApproval<TDecision>>,
  requestId: string,
  message: string,
) {
  for (const [proposalId, pending] of approvals) {
    if (pending.requestId !== requestId) continue;
    approvals.delete(proposalId);
    pending.reject(new Error(message));
  }
}

export function useAiProposalApprovals() {
  const commandApprovalsRef = useRef(
    new Map<string, PendingApproval<AiCommandApprovalDecision>>(),
  );
  const fileApprovalsRef = useRef(
    new Map<string, PendingApproval<AiFileApprovalDecision>>(),
  );

  const decideCommandProposal = useCallback(
    (proposalId: string, decision: AiCommandApprovalDecision) => {
      const pending = commandApprovalsRef.current.get(proposalId);
      if (!pending) return false;
      commandApprovalsRef.current.delete(proposalId);
      pending.resolve(decision);
      return true;
    },
    [],
  );

  const decideFileProposal = useCallback(
    (proposalId: string, decision: AiFileApprovalDecision) => {
      const pending = fileApprovalsRef.current.get(proposalId);
      if (!pending) return false;
      fileApprovalsRef.current.delete(proposalId);
      pending.resolve(decision);
      return true;
    },
    [],
  );

  const waitForCommandApproval = useCallback(
    (proposalId: string, requestId: string) =>
      new Promise<AiCommandApprovalDecision>((resolve, reject) => {
        commandApprovalsRef.current.set(proposalId, {
          reject,
          requestId,
          resolve,
        });
      }),
    [],
  );

  const waitForFileApproval = useCallback(
    (proposalId: string, requestId: string) =>
      new Promise<AiFileApprovalDecision>((resolve, reject) => {
        fileApprovalsRef.current.set(proposalId, {
          reject,
          requestId,
          resolve,
        });
      }),
    [],
  );

  const rejectPendingCommandApprovals = useCallback(
    (requestId: string, message = "AI 请求已取消") => {
      rejectApprovalsForRequest(
        commandApprovalsRef.current,
        requestId,
        message,
      );
    },
    [],
  );

  const rejectPendingFileApprovals = useCallback(
    (requestId: string, message = "AI 请求已取消") => {
      rejectApprovalsForRequest(fileApprovalsRef.current, requestId, message);
    },
    [],
  );

  return {
    decideCommandProposal,
    decideFileProposal,
    rejectPendingCommandApprovals,
    rejectPendingFileApprovals,
    waitForCommandApproval,
    waitForFileApproval,
  };
}
