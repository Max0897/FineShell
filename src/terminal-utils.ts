import type {
  HostRecord,
  JumpHostConnection,
  TerminalSessionStatus,
} from "./models";

const MAX_TRACKED_TERMINAL_INPUT_CHARS = 4_096;

export interface TerminalInputState {
  reliable: boolean;
  value: string;
}

export interface TerminalInjectedInput {
  id: string;
  submit?: boolean;
  value: string;
}

export interface TerminalCommandSubmission {
  command: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  hostId: string;
  id: string;
  output?: string;
  outputTruncated?: boolean;
  stdout?: string;
  stdoutTruncated?: boolean;
  stderr?: string;
  stderrTruncated?: boolean;
  phase?: "submitted" | "completed" | "unavailable";
  reason?: string;
  sessionId: string;
  submittedAt: string;
}

type TerminalPasteKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
>;

export const EMPTY_TERMINAL_INPUT_STATE: TerminalInputState = {
  reliable: true,
  value: "",
};

export function isWindowsTerminalPasteShortcut(
  event: TerminalPasteKeyEvent,
  platform: string = navigator.platform,
) {
  return (
    /^win/i.test(platform) &&
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "v"
  );
}

function removeLastCharacter(value: string) {
  return Array.from(value).slice(0, -1).join("");
}

function removeLastWord(value: string) {
  return value.replace(/\s+$/u, "").replace(/\S+$/u, "");
}

export function appendInjectedTerminalInput(
  state: TerminalInputState,
  value: string,
): TerminalInputState {
  if (!state.reliable) return state;
  const nextValue = `${state.value}${value}`;
  return nextValue.length <= MAX_TRACKED_TERMINAL_INPUT_CHARS
    ? { reliable: true, value: nextValue }
    : { reliable: false, value: "" };
}

export function trackInjectedTerminalInput(
  state: TerminalInputState,
  input: Pick<TerminalInjectedInput, "submit" | "value">,
) {
  const inserted = appendInjectedTerminalInput(state, input.value);
  return input.submit
    ? trackTerminalInput(inserted, "\r")
    : { state: inserted, submissions: [] as string[] };
}

export function terminalInjectedInputData(
  input: Pick<TerminalInjectedInput, "submit" | "value">,
) {
  return `${input.value}${input.submit ? "\r" : ""}`;
}

export function consumeTerminalCommandCandidate(
  candidates: string[],
  command: string,
): { candidates: string[]; matched: boolean } {
  const index = candidates.lastIndexOf(command);
  if (index < 0) return { candidates, matched: false };
  return {
    candidates: candidates.filter(
      (_, candidateIndex) => candidateIndex !== index,
    ),
    matched: true,
  };
}

export function trackTerminalInput(
  state: TerminalInputState,
  data: string,
): { state: TerminalInputState; submissions: string[] } {
  let current = { ...state };
  const submissions: string[] = [];

  for (const character of Array.from(data)) {
    if (character === "\r" || character === "\n") {
      if (current.reliable && current.value.trim()) {
        submissions.push(current.value.trim());
      }
      current = { ...EMPTY_TERMINAL_INPUT_STATE };
      continue;
    }
    if (character === "\u0003" || character === "\u0015") {
      current = { ...EMPTY_TERMINAL_INPUT_STATE };
      continue;
    }
    if (character === "\b" || character === "\u007f") {
      if (current.reliable) {
        current.value = removeLastCharacter(current.value);
      }
      continue;
    }
    if (character === "\u0017") {
      if (current.reliable) current.value = removeLastWord(current.value);
      continue;
    }
    if (character.charCodeAt(0) < 32) {
      current = { reliable: false, value: "" };
      continue;
    }
    if (!current.reliable) continue;
    current.value += character;
    if (current.value.length > MAX_TRACKED_TERMINAL_INPUT_CHARS) {
      current = { reliable: false, value: "" };
    }
  }

  return { state: current, submissions };
}

interface SessionTabTarget {
  id: string;
  host: Pick<HostRecord, "id" | "name">;
}

export function decodeSshOutput(value: string) {
  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(value.padEnd(value.length + padding, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function reconnectDelaySeconds(attempt: number) {
  return Math.min(30, 2 ** Math.max(0, Math.floor(attempt) - 1));
}

export function isTerminalSessionOperational(status: TerminalSessionStatus) {
  return status === "connected" || status === "suspect";
}

export function terminalStatusNoticeKey(
  status: TerminalSessionStatus,
  error?: string,
) {
  return status === "failed" || status === "disconnected"
    ? `${status}:${error ?? ""}`
    : status;
}

export function sessionTabName(
  sessions: SessionTabTarget[],
  sessionId: string,
) {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return "";
  const session = sessions[index];
  const occurrence = sessions
    .slice(0, index + 1)
    .filter((item) => item.host.id === session.host.id).length;
  return occurrence > 1
    ? `${session.host.name} (${occurrence})`
    : session.host.name;
}

export function sshCredentialId(host: HostRecord) {
  return host.authMethod === "privateKey" && host.sshKeyId
    ? host.sshKeyId
    : host.id;
}

export function jumpHostRequest(connection?: JumpHostConnection) {
  if (!connection) return undefined;
  const { host, proxy } = connection;
  return {
    hostId: sshCredentialId(host),
    address: host.address,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    privateKeyPath: host.privateKeyPath,
    connectTimeoutSeconds: host.connectTimeoutSeconds,
    keepAliveIntervalSeconds: host.keepAliveIntervalSeconds,
    expectedFingerprint: host.hostFingerprint,
    proxy,
  };
}
