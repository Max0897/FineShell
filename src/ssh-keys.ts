import type { SshKeyRecord, SshKeySource } from "./models";

export const MANAGED_SSH_KEY_PREFIX = "managed://";

export function getSshKeySource(
  sshKey: Pick<SshKeyRecord, "source" | "privateKeyPath">,
): SshKeySource {
  return sshKey.source === "managed" ||
    sshKey.privateKeyPath.startsWith(MANAGED_SSH_KEY_PREFIX)
    ? "managed"
    : "file";
}

export function managedSshKeyReference(sshKeyId: string) {
  return `${MANAGED_SSH_KEY_PREFIX}${sshKeyId}`;
}
