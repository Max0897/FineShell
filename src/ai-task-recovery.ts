import type {
  AgentTask,
  AgentTaskRecoveryContext,
  AgentTaskRecoveryDecision,
} from "./tauri-protocol";

export function agentTaskNeedsRecovery(task?: AgentTask): task is AgentTask {
  return task?.status === "paused" || task?.status === "paused_disconnected";
}

/**
 * A command that timed out, was cancelled, or lost its connection only had its
 * SSH channel closed; the remote process may still be running.
 */
export function agentTaskMayHaveRunningCommand(task?: AgentTask) {
  return Boolean(
    task?.actions.some(
      (action) =>
        action.commandExecution?.phase === "interrupted" ||
        action.commandExecution?.phase === "cancelling",
    ),
  );
}

function recoveryList(values: string[], fallback: string): string {
  if (!values.length) return `- ${fallback}`;
  return values.map((value) => `- ${value}`).join("\n");
}

export function buildAgentRecoveryPrompt(
  recovery: AgentTaskRecoveryContext,
  decision: Exclude<AgentTaskRecoveryDecision, "finish">,
  { remoteCommandMayBeRunning = false }: { remoteCommandMayBeRunning?: boolean } = {},
): string {
  const objective = recovery.objective.slice(0, 16_000);
  const intent =
    decision === "retry"
      ? "请从服务器当前真实状态重新规划并完成原目标。只读检查可以按需重新执行；任何命令或文件修改都必须生成全新的动作，并重新请求审批。"
      : "请基于已有结果继续分析原目标。先重新确认所有不确定状态，不要假设中断中的动作已经成功；如需命令或文件修改，必须生成全新的动作并重新请求审批。";
  return [
    "这是一个中断任务的安全后继任务。",
    `原目标：${objective}`,
    `中断原因：${recovery.interruptionReason}`,
    "已确认完成的动作：",
    recoveryList(recovery.completedActions, "无"),
    "结果不确定或未完成的动作：",
    recoveryList(recovery.uncertainActions, "无"),
    ...(remoteCommandMayBeRunning
      ? [
          "注意：有命令因超时、取消或断线被中断，但远端进程可能仍在运行。重新执行同类命令前，先用只读命令（如 ps、pgrep、systemctl status）确认它是否仍在运行，避免重复执行。",
        ]
      : []),
    intent,
  ].join("\n");
}
