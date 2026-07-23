import type { HostRecord, JumpHostConnection } from "./models";

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
