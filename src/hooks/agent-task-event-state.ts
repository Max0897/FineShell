import {
  PROTOCOL_VERSION,
  type AgentTask,
  type AgentTaskEventPayload,
  type AgentTaskSync,
} from "../tauri-protocol";

function newerTask(
  current: AgentTask | undefined,
  candidate: AgentTask,
): AgentTask {
  if (
    current?.id === candidate.id &&
    current.lastEventSequence >= candidate.lastEventSequence
  ) {
    return current;
  }
  return candidate;
}

export function applyAgentTaskEvent(
  current: AgentTask | undefined,
  trackedTaskId: string | undefined,
  event: AgentTaskEventPayload,
): AgentTask | undefined {
  if (
    !trackedTaskId ||
    event.protocolVersion !== PROTOCOL_VERSION ||
    event.task.id !== trackedTaskId ||
    event.sequence !== event.task.lastEventSequence
  ) {
    return current;
  }
  return newerTask(current, event.task);
}

export function reconcileAgentTaskSync(
  current: AgentTask | undefined,
  trackedTaskId: string,
  sync: AgentTaskSync,
): AgentTask | undefined {
  let next = current?.id === trackedTaskId ? current : undefined;
  if (sync.task?.id === trackedTaskId) {
    next = newerTask(next, sync.task);
  }
  for (const event of sync.events) {
    next = applyAgentTaskEvent(next, trackedTaskId, event);
  }
  return next;
}
