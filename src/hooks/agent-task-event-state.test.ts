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
    expect(
      applyAgentTaskEvent(next, "task-1", {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 6,
        task: task("task-2", 6),
      }),
    ).toBe(next);
    expect(
      applyAgentTaskEvent(next, "task-1", {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION,
        sequence: 7,
        task: task("task-1", 6),
      }),
    ).toBe(next);
    expect(
      applyAgentTaskEvent(next, undefined, {
        kind: "plan_updated",
        protocolVersion: PROTOCOL_VERSION,
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

  test("keeps the newest task across stale snapshots and unordered replay", () => {
    const current = task("task-1", 8);
    const newest = task("task-1", 10);
    expect(
      reconcileAgentTaskSync(current, "task-1", {
        task: task("task-1", 3),
        events: [
          {
            kind: "task_completed",
            protocolVersion: PROTOCOL_VERSION,
            sequence: 10,
            task: newest,
          },
          {
            kind: "plan_updated",
            protocolVersion: PROTOCOL_VERSION,
            sequence: 9,
            task: task("task-1", 9),
          },
          {
            kind: "task_completed",
            protocolVersion: PROTOCOL_VERSION,
            sequence: 11,
            task: task("task-2", 11),
          },
          {
            kind: "task_completed",
            protocolVersion: PROTOCOL_VERSION + 1,
            sequence: 12,
            task: task("task-1", 12),
          },
        ],
      }),
    ).toBe(newest);
  });

  test("drops unrelated local state before applying the tracked snapshot", () => {
    const snapshot = task("task-1", 2);
    expect(
      reconcileAgentTaskSync(task("task-2", 20), "task-1", {
        task: snapshot,
        events: [],
      }),
    ).toBe(snapshot);
    expect(
      reconcileAgentTaskSync(task("task-2", 20), "task-1", {
        task: task("task-2", 21),
        events: [],
      }),
    ).toBeUndefined();
  });
});
