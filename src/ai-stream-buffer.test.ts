import { describe, expect, mock, test } from "bun:test";
import { AiStreamBuffer, type AiStreamTarget } from "./ai-stream-buffer";

const TARGET: AiStreamTarget = {
  requestId: "request-1",
  hostId: "host-1",
  conversationId: "conversation-1",
  assistantId: "assistant-1",
};

function createBuffer() {
  const frames: Array<() => void> = [];
  const cancelled = new Set<number>();
  const onFlush = mock(() => undefined);
  const buffer = new AiStreamBuffer(onFlush, {
    schedule: (callback) => frames.push(callback) - 1,
    cancel: (handle) => cancelled.add(handle),
  });
  const runFrames = () => {
    frames.splice(0).forEach((callback, index) => {
      if (!cancelled.has(index)) callback();
    });
  };
  return { buffer, frames, onFlush, runFrames };
}

describe("AiStreamBuffer", () => {
  test("coalesces deltas into one update per frame", () => {
    const { buffer, frames, onFlush, runFrames } = createBuffer();
    buffer.begin(TARGET);

    buffer.push("request-1", "content", "Hel");
    buffer.push("request-1", "content", "lo");
    buffer.push("request-1", "reasoning", "thinking");

    expect(frames).toHaveLength(1);
    expect(onFlush).not.toHaveBeenCalled();
    runFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(TARGET, {
      content: "Hello",
      reasoning: "thinking",
    });
  });

  test("ignores deltas outside the active turn or for other requests", () => {
    const { buffer, frames } = createBuffer();

    expect(buffer.push("request-1", "content", "early")).toBe(false);
    buffer.begin(TARGET);
    expect(buffer.push("request-2", "content", "other")).toBe(false);
    buffer.end();
    expect(buffer.push("request-1", "content", "late")).toBe(false);
    expect(frames).toHaveLength(0);
  });

  test("applies pending deltas synchronously when the turn ends", () => {
    const { buffer, onFlush, runFrames } = createBuffer();
    buffer.begin(TARGET);
    buffer.push("request-1", "reasoning", "last thought");

    buffer.end();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(TARGET, {
      content: "",
      reasoning: "last thought",
    });

    runFrames();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
