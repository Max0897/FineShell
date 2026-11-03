export interface AiStreamTarget {
  requestId: string;
  hostId: string;
  conversationId: string;
  assistantId: string;
}

export interface AiStreamChunk {
  content: string;
  reasoning: string;
}

interface AiStreamScheduler {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

const animationFrameScheduler: AiStreamScheduler = {
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Coalesces streamed deltas into at most one UI update per frame, and only
 * accepts deltas while a model turn is in flight. Deltas that arrive after the
 * turn's final result (events and the command response travel on separate
 * channels) are dropped instead of being appended to the final content.
 */
export class AiStreamBuffer {
  private target: AiStreamTarget | undefined;
  private pending: AiStreamChunk = { content: "", reasoning: "" };
  private frame: number | undefined;

  constructor(
    private readonly onFlush: (target: AiStreamTarget, chunk: AiStreamChunk) => void,
    private readonly scheduler: AiStreamScheduler = animationFrameScheduler,
  ) {}

  begin(target: AiStreamTarget) {
    this.discard();
    this.target = target;
  }

  push(requestId: string, kind: "content" | "reasoning", delta: string) {
    if (!this.target || this.target.requestId !== requestId || !delta) {
      return false;
    }
    this.pending[kind] += delta;
    this.frame ??= this.scheduler.schedule(() => {
      this.frame = undefined;
      this.flush();
    });
    return true;
  }

  /**
   * Ends the turn. Pending deltas are applied synchronously, before the
   * caller writes the final result, so nothing is appended after it.
   */
  end() {
    this.flush();
    this.discard();
    this.target = undefined;
  }

  private flush() {
    const target = this.target;
    const chunk = this.pending;
    this.pending = { content: "", reasoning: "" };
    if (target && (chunk.content || chunk.reasoning)) this.onFlush(target, chunk);
  }

  private discard() {
    if (this.frame !== undefined) this.scheduler.cancel(this.frame);
    this.frame = undefined;
    this.pending = { content: "", reasoning: "" };
  }
}
