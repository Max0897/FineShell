import type { AiToolCall, AiToolResult } from "./tauri-protocol";

export type AiFileApprovalDecision =
  | { kind: "execution_completed"; summary: string }
  | { kind: "execution_failed"; reason: string }
  | { kind: "rejected" }
  | { feedback: string; kind: "revision_requested" };

export function aiFileApprovalToolResult(
  call: AiToolCall,
  decision: AiFileApprovalDecision,
): AiToolResult {
  const content =
    decision.kind === "execution_completed"
      ? {
          decision: "approved_and_completed",
          message: decision.summary,
          ok: true,
        }
      : decision.kind === "execution_failed"
        ? {
            decision: "execution_failed",
            error: decision.reason,
            message: "文件操作已获批准，但执行失败",
            ok: false,
          }
        : decision.kind === "revision_requested"
          ? {
              decision: "revision_requested",
              feedback: decision.feedback.trim(),
              message: "用户拒绝了当前文件操作，并要求按反馈重新提案",
              ok: false,
            }
          : {
              decision: "rejected",
              message: "用户拒绝了当前文件操作，不得执行",
              ok: false,
            };
  return {
    callId: call.id,
    content: JSON.stringify(content),
    name: call.name,
  };
}
