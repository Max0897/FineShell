import type { TerminalSessionStatus } from "./models";
import { diagnosticInvoke } from "./diagnostics";

const DEFAULT_FLUSH_DELAY_MS = 200;
const DEFAULT_BATCH_SIZE = 64 * 1024;

export interface TerminalLogStartOptions {
  logId: string;
  sessionId: string;
  directory: string;
  hostName: string;
  address: string;
  username: string;
  startedAt: string;
  format: "plain" | "raw";
  maxFileSizeMb: number;
}

interface TerminalLogStartResult {
  path: string;
}

export interface TerminalLogTransport {
  start(options: TerminalLogStartOptions): Promise<TerminalLogStartResult>;
  append(logId: string, data: string): Promise<void>;
  marker(logId: string, timestamp: string, message: string): Promise<void>;
  stop(logId: string): Promise<void>;
}

interface TerminalLogBatcherOptions {
  batchSize?: number;
  flushDelayMs?: number;
  onError?: (error: unknown) => void;
  transport?: TerminalLogTransport;
}

function encodeBase64(data: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function combineChunks(chunks: Uint8Array[], byteLength: number) {
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export function createTerminalLogTransport(): TerminalLogTransport {
  return {
    start: (request) =>
      diagnosticInvoke<TerminalLogStartResult>("terminal_log_start", {
        request,
      }),
    append: (logId, data) =>
      diagnosticInvoke("terminal_log_append", { data, logId }),
    marker: (logId, timestamp, message) =>
      diagnosticInvoke("terminal_log_marker", {
        logId,
        message,
        timestamp,
      }),
    stop: (logId) => diagnosticInvoke("terminal_log_stop", { logId }),
  };
}

export function resolveDefaultTerminalLogDirectory() {
  return diagnosticInvoke<string>("terminal_log_default_directory");
}

export class TerminalLogBatcher {
  private readonly batchSize: number;
  private readonly flushDelayMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly options: TerminalLogStartOptions;
  private readonly ready: Promise<boolean>;
  private readonly transport: TerminalLogTransport;
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private failed = false;
  private failureReported = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    options: TerminalLogStartOptions,
    batcherOptions: TerminalLogBatcherOptions = {},
  ) {
    this.options = options;
    this.batchSize = batcherOptions.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushDelayMs =
      batcherOptions.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.onError = batcherOptions.onError;
    this.transport = batcherOptions.transport ?? createTerminalLogTransport();
    this.ready = this.transport
      .start(options)
      .then(() => true)
      .catch((error) => {
        this.reportFailure(error);
        return false;
      });
  }

  append(data: Uint8Array) {
    if (this.stopped || this.failed || data.length === 0) return;
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.chunks.push(copy);
    this.byteLength += copy.length;
    if (this.byteLength >= this.batchSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushDelayMs);
    }
  }

  flush() {
    this.clearTimer();
    if (this.byteLength === 0) return this.queue;
    const data = combineChunks(this.chunks, this.byteLength);
    this.chunks = [];
    this.byteLength = 0;
    return this.enqueue(() =>
      this.transport.append(this.options.logId, encodeBase64(data)),
    );
  }

  marker(timestamp: string, message: string) {
    if (this.stopped || this.failed) return this.queue;
    void this.flush();
    return this.enqueue(() =>
      this.transport.marker(this.options.logId, timestamp, message),
    );
  }

  stop() {
    if (this.stopped) return this.queue;
    this.stopped = true;
    void this.flush();
    return this.enqueue(
      () => this.transport.stop(this.options.logId),
      true,
    );
  }

  private enqueue(operation: () => Promise<void>, cleanup = false) {
    this.queue = this.queue
      .then(async () => {
        const ready = await this.ready;
        if (!ready || (this.failed && !cleanup)) return;
        await operation();
      })
      .catch((error) => this.reportFailure(error));
    return this.queue;
  }

  private clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private reportFailure(error: unknown) {
    this.failed = true;
    this.clearTimer();
    this.chunks = [];
    this.byteLength = 0;
    if (this.failureReported) return;
    this.failureReported = true;
    this.onError?.(error);
  }
}

export function terminalLogStatusMessage(
  status: TerminalSessionStatus,
  error?: string,
) {
  if (status === "connecting") return "开始连接";
  if (status === "connected") return "连接成功";
  if (status === "suspect") return "连接状态异常";
  if (status === "reconnecting") return "正在重新连接";
  if (status === "failed") return error ? `连接失败：${error}` : "连接失败";
  return error ? `连接已断开：${error}` : "连接已断开";
}
