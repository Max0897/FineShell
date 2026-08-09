import { sanitizeAppSettings, type AppSettings } from "./app-settings";
import { applyConnectionHistoryPolicy } from "./connection-history";
import {
  sanitizeCredentialReference,
  type CredentialKind,
  type CredentialReferenceRecord,
} from "./credential-registry";
import {
  createBackup,
  MAX_CONFIGURATION_BACKUPS,
  sanitizeQuickCommand,
  sanitizeSftpLocation,
  TRASH_RETENTION_DAYS,
  updateConfiguration,
  type DeletedHostRecord,
  type FineShellConfiguration,
} from "./config-database";
import {
  deriveKnownHostRecords,
  knownHostTargetKey,
  normalizeHostFingerprint,
  removeKnownHostTrust,
  upsertKnownHostRecord,
} from "./known-hosts";
import type {
  ConnectionHistoryRecord,
  HostRecord,
  HostSortMode,
  ProxyRecord,
  QuickCommandRecord,
  SftpLocationRecord,
  SshKeyRecord,
} from "./models";
import { recordTerminalCommand as recordTerminalCommandInHistory } from "./terminal-command-history";

export function replaceConfigurationContent(
  hosts: HostRecord[],
  history: ConnectionHistoryRecord[],
) {
  return updateConfiguration((current) => ({
    ...current,
    hosts,
    history,
  }));
}

export function updateStoredHostFingerprint(
  host: Pick<HostRecord, "id" | "address" | "port" | "username">,
  fingerprint: string,
  verifiedAt = new Date().toISOString(),
) {
  const normalizedFingerprint = normalizeHostFingerprint(fingerprint);
  if (!normalizedFingerprint) {
    return Promise.reject(new Error("主机指纹不能为空"));
  }
  const targetKey = knownHostTargetKey(host.address, host.port);
  return updateConfiguration((current) => ({
    ...current,
    hosts: current.hosts.map((item) =>
      knownHostTargetKey(item.address, item.port) === targetKey
        ? { ...item, hostFingerprint: normalizedFingerprint }
        : item,
    ),
    history: current.history.map((item) =>
      knownHostTargetKey(item.address, item.port) === targetKey
        ? { ...item, hostFingerprint: normalizedFingerprint }
        : item,
    ),
    knownHosts: upsertKnownHostRecord(
      current.knownHosts,
      host,
      normalizedFingerprint,
      verifiedAt,
    ),
  }));
}

export function removeKnownHostFingerprints(knownHostIds: string[]) {
  return updateConfiguration((current) => {
    const next = removeKnownHostTrust(
      current.knownHosts,
      current.hosts,
      current.history,
      knownHostIds,
    );
    return {
      ...current,
      ...next,
    };
  });
}

export function importConfiguration(
  imported: Pick<
    FineShellConfiguration,
    | "hosts"
    | "history"
    | "proxies"
    | "sshKeys"
    | "quickCommands"
    | "hostSort"
    | "sftpLocations"
    | "knownHosts"
    | "settings"
  >,
) {
  return updateConfiguration((current) => ({
    ...current,
    hosts: imported.hosts,
    history: imported.history,
    proxies: imported.proxies,
    sshKeys: imported.sshKeys,
    quickCommands: imported.quickCommands,
    hostSort: imported.hostSort,
    sftpLocations: imported.sftpLocations,
    knownHosts: imported.knownHosts,
    settings: imported.settings,
    backups: [
      createBackup(current, "导入配置前自动备份"),
      ...current.backups,
    ].slice(0, MAX_CONFIGURATION_BACKUPS),
  }));
}

export function restoreCredentialReferences(
  references: CredentialReferenceRecord[],
) {
  return updateConfiguration((current) => ({
    ...current,
    credentialReferences: [
      ...new Map(
        [...current.credentialReferences, ...references]
          .map(sanitizeCredentialReference)
          .filter((item): item is CredentialReferenceRecord => Boolean(item))
          .map((item) => [item.id, item]),
      ).values(),
    ],
  }));
}

export function restoreConfigurationBackup(backupId: string) {
  return updateConfiguration((current) => {
    const backup = current.backups.find((item) => item.id === backupId);
    if (!backup) throw new Error("备份不存在或已被清理");

    return {
      ...current,
      hosts: backup.hosts,
      history: backup.history,
      proxies: backup.proxies,
      sshKeys: backup.sshKeys,
      quickCommands: backup.quickCommands,
      hostSort: backup.hostSort,
      sftpLocations: backup.sftpLocations,
      knownHosts:
        backup.knownHosts ??
        deriveKnownHostRecords(backup.hosts, backup.history, backup.createdAt),
      settings: backup.settings ?? current.settings,
      backups: [
        createBackup(current, "恢复配置前自动备份"),
        ...current.backups,
      ].slice(0, MAX_CONFIGURATION_BACKUPS),
    };
  });
}

export function createDeletedHostRecord(
  host: HostRecord,
  now = new Date(),
): DeletedHostRecord {
  const deletedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    id: `trash-${host.id}-${now.getTime()}`,
    host,
    deletedAt,
    expiresAt,
  };
}

export function isDeletedHostExpired(
  deletedHost: Pick<DeletedHostRecord, "expiresAt">,
  now = new Date(),
) {
  return Date.parse(deletedHost.expiresAt) <= now.getTime();
}

export function moveHostToTrash(hostId: string) {
  return updateConfiguration((current) => {
    const host = current.hosts.find((item) => item.id === hostId);
    if (!host) throw new Error("主机不存在或已被删除");

    return {
      ...current,
      hosts: current.hosts
        .filter((item) => item.id !== hostId)
        .map((item) =>
          item.jumpHostId === hostId
            ? { ...item, jumpHostId: undefined }
            : item,
        ),
      history: current.history.map((record) =>
        record.jumpHostId === hostId
          ? { ...record, jumpHostId: undefined }
          : record,
      ),
      backups: [
        createBackup(current, "删除主机前自动备份"),
        ...current.backups,
      ].slice(0, MAX_CONFIGURATION_BACKUPS),
      trash: [
        createDeletedHostRecord(host),
        ...current.trash.filter((item) => item.host.id !== hostId),
      ],
    };
  });
}

export function restoreDeletedHost(deletedHostId: string) {
  return updateConfiguration((current) => {
    const deletedHost = current.trash.find((item) => item.id === deletedHostId);
    if (!deletedHost) throw new Error("回收站记录不存在或已过期");
    if (current.hosts.some((item) => item.id === deletedHost.host.id)) {
      throw new Error("当前主机列表中已存在同一主机，无法恢复");
    }

    return {
      ...current,
      hosts: [...current.hosts, deletedHost.host],
      trash: current.trash.filter((item) => item.id !== deletedHostId),
    };
  });
}

export function permanentlyDeleteHost(deletedHostId: string) {
  return updateConfiguration((current) => {
    const hostId = current.trash.find((item) => item.id === deletedHostId)?.host
      .id;
    return {
      ...current,
      sftpLocations: hostId
        ? current.sftpLocations.filter((item) => item.hostId !== hostId)
        : current.sftpLocations,
      terminalCommandHistory: hostId
        ? current.terminalCommandHistory.filter(
            (item) => item.hostId !== hostId,
          )
        : current.terminalCommandHistory,
      trash: current.trash.filter((item) => item.id !== deletedHostId),
    };
  });
}

export async function purgeExpiredDeletedHosts(now = new Date()) {
  const expiredHostIds: string[] = [];
  const configuration = await updateConfiguration((current) => {
    const trash = current.trash.filter((item) => {
      if (!isDeletedHostExpired(item, now)) return true;
      if (!current.hosts.some((host) => host.id === item.host.id)) {
        expiredHostIds.push(item.host.id);
      }
      return false;
    });
    return {
      ...current,
      sftpLocations: current.sftpLocations.filter(
        (item) => !expiredHostIds.includes(item.hostId),
      ),
      terminalCommandHistory: current.terminalCommandHistory.filter(
        (item) => !expiredHostIds.includes(item.hostId),
      ),
      trash,
    };
  });
  return { configuration, expiredHostIds };
}

export function updateHostSortMode(hostSort: HostSortMode) {
  return updateConfiguration((current) => ({ ...current, hostSort }));
}

export function upsertSftpLocation(location: SftpLocationRecord) {
  const sanitized = sanitizeSftpLocation(location);
  if (!sanitized) return Promise.reject(new Error("SFTP 位置记录无效"));
  return updateConfiguration((current) => ({
    ...current,
    sftpLocations:
      sanitized.bookmarks.length || sanitized.history.length
        ? current.sftpLocations.some((item) => item.hostId === sanitized.hostId)
          ? current.sftpLocations.map((item) =>
              item.hostId === sanitized.hostId ? sanitized : item,
            )
          : [...current.sftpLocations, sanitized]
        : current.sftpLocations.filter(
            (item) => item.hostId !== sanitized.hostId,
          ),
  }));
}

export function upsertProxy(proxy: ProxyRecord) {
  return updateConfiguration((current) => ({
    ...current,
    proxies: current.proxies.some((item) => item.id === proxy.id)
      ? current.proxies.map((item) => (item.id === proxy.id ? proxy : item))
      : [...current.proxies, proxy],
  }));
}

export function deleteProxy(proxyId: string) {
  return updateConfiguration((current) => ({
    ...current,
    proxies: current.proxies.filter((item) => item.id !== proxyId),
    hosts: current.hosts.map((host) =>
      host.proxyId === proxyId ? { ...host, proxyId: undefined } : host,
    ),
    history: current.history.map((record) =>
      record.proxyId === proxyId ? { ...record, proxyId: undefined } : record,
    ),
  }));
}

export function upsertSshKey(sshKey: SshKeyRecord) {
  return updateConfiguration((current) => ({
    ...current,
    sshKeys: current.sshKeys.some((item) => item.id === sshKey.id)
      ? current.sshKeys.map((item) => (item.id === sshKey.id ? sshKey : item))
      : [...current.sshKeys, sshKey],
  }));
}

export function deleteSshKey(sshKeyId: string) {
  return updateConfiguration((current) => {
    const activeUsage = current.hosts.filter(
      (host) => host.sshKeyId === sshKeyId,
    );
    const trashUsage = current.trash.filter(
      (item) => item.host.sshKeyId === sshKeyId,
    );
    if (activeUsage.length || trashUsage.length) {
      throw new Error("该密钥仍被主机或回收站记录使用，无法删除");
    }

    return {
      ...current,
      sshKeys: current.sshKeys.filter((item) => item.id !== sshKeyId),
      history: current.history.filter((record) => record.sshKeyId !== sshKeyId),
    };
  });
}

export function upsertQuickCommand(command: QuickCommandRecord) {
  const sanitized = sanitizeQuickCommand(command);
  if (!sanitized) {
    return Promise.reject(new Error("快捷命令内容无效"));
  }
  return updateConfiguration((current) => ({
    ...current,
    quickCommands: current.quickCommands.some(
      (item) => item.id === sanitized.id,
    )
      ? current.quickCommands.map((item) =>
          item.id === sanitized.id ? sanitized : item,
        )
      : [...current.quickCommands, sanitized],
  }));
}

export function deleteQuickCommand(commandId: string) {
  return updateConfiguration((current) => ({
    ...current,
    quickCommands: current.quickCommands.filter(
      (item) => item.id !== commandId,
    ),
  }));
}

export function updateAppSettings(settings: AppSettings) {
  return updateConfiguration((current) => {
    const sanitized = sanitizeAppSettings(settings);
    return {
      ...current,
      history: applyConnectionHistoryPolicy(current.history, sanitized),
      settings: sanitized,
    };
  });
}

export function clearConnectionHistory() {
  return updateConfiguration((current) => ({ ...current, history: [] }));
}

export function recordTerminalCommandHistory(
  hostId: string,
  command: string,
  cwd?: string,
) {
  return updateConfiguration((current) => ({
    ...current,
    terminalCommandHistory: recordTerminalCommandInHistory(
      current.terminalCommandHistory,
      { hostId, command, cwd },
    ),
  }));
}

export function clearTerminalCommandHistory() {
  return updateConfiguration((current) => ({
    ...current,
    terminalCommandHistory: [],
  }));
}

export function upsertCredentialReference(
  reference: CredentialReferenceRecord,
) {
  const sanitized = sanitizeCredentialReference(reference);
  if (!sanitized) return Promise.reject(new Error("凭据索引无效"));
  return updateConfiguration((current) => ({
    ...current,
    credentialReferences: current.credentialReferences.some(
      (item) => item.id === sanitized.id,
    )
      ? current.credentialReferences.map((item) =>
          item.id === sanitized.id ? sanitized : item,
        )
      : [...current.credentialReferences, sanitized],
  }));
}

export function replaceCredentialReferences(
  references: CredentialReferenceRecord[],
) {
  return updateConfiguration((current) => ({
    ...current,
    credentialReferences: references,
  }));
}

export function removeCredentialReference(
  kind: CredentialKind,
  ownerId: string,
) {
  const id = `${kind}:${ownerId}`;
  return updateConfiguration((current) => ({
    ...current,
    credentialReferences: current.credentialReferences.filter(
      (item) => item.id !== id,
    ),
  }));
}
