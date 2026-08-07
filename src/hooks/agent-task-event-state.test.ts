import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type AgentTask } from "../tauri-protocol";
import {
  applyAgentTaskEvent,
  reconcileAgentTaskSync,
} from "./agent-task-event-state";

function task(id: string, sequence: number): AgentTask {
  return {
    id,
    lastEventSequence: sequence,
  } as AgentTask;
}

describe("agent task event state", () => {
  test("accepts only matching monotonic protocol events", () => {
    const current = task("task-1", 4);
    const next = task("task-1", 5);
    expect(
      applyAgentTaskEvent(current, "task-1", {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 5,
        task: next,
      }),
    ).toBe(next);
    expect(
      applyAgentTaskEvent(next, "task-1", {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 4,
        task: current,
      }),
    ).toBe(next);
    expect(
      applyAgentTaskEvent(next, "task-1", {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION + 1,
        sequence: 6,
        task: task("task-1", 6),
      }),
    ).toBe(next);
  });

  test("reconciles a snapshot with later events", () => {
    const snapshot = task("task-1", 3);
    const replayed = task("task-1", 5);
    expect(
      reconcileAgentTaskSync(undefined, "task-1", {
        task: snapshot,
        events: [{
          kind: "task_completed",
          protocolVersion: PROTOCOL_VERSION,
          sequence: 5,
          task: replayed,
        }],
      }),
    ).toBe(replayed);
  });
});
