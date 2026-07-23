import type { HostRecord, JumpHostConnection } from "./models";

export function decodeSshOutput(value: string) {
  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(value.padEnd(value.length + padding, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function reconnectDelaySeconds(attempt: number) {
  return Math.min(30, 2 ** Math.max(0, Math.floor(attempt) - 1));
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
