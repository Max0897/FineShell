import type {
  ConnectionHistoryRecord,
  HostRecord,
  ProxyRecord,
  SshKeyRecord,
} from "./models";

export type CredentialKind =
  | "hostPassword"
  | "privateKeyPassphrase"
  | "proxyPassword";

export interface CredentialReferenceRecord {
  id: string;
  kind: CredentialKind;
  ownerId: string;
  label: string;
  updatedAt: string;
}

export interface CredentialProbe {
  kind: CredentialKind;
  ownerId: string;
}

export interface CredentialProbeResult extends CredentialProbe {
  exists: boolean;
}

interface CredentialConfiguration {
  hosts: HostRecord[];
  history: ConnectionHistoryRecord[];
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  trash: Array<{ host: HostRecord }>;
}

export function credentialReferenceId(kind: CredentialKind, ownerId: string) {
  return `${kind}:${ownerId}`;
}

export function connectionTargetKey(
  target: Pick<
    HostRecord,
    "address" | "port" | "username" | "proxyId" | "jumpHostId"
  >,
) {
  return `${target.username}@${target.address}:${target.port}#${target.proxyId ?? "direct"}#${target.jumpHostId ?? "no-jump"}`;
}

export function quickCredentialOwnerId(
  target: Pick<
    HostRecord,
    "address" | "port" | "username" | "proxyId" | "jumpHostId"
  >,
) {
  return `quick-${connectionTargetKey(target)}`;
}

export function createCredentialReference(
  kind: CredentialKind,
  ownerId: string,
  label: string,
  updatedAt = new Date().toISOString(),
): CredentialReferenceRecord {
  return {
    id: credentialReferenceId(kind, ownerId),
    kind,
    ownerId,
    label,
    updatedAt,
  };
}

export function sanitizeCredentialReference(
  value: unknown,
): CredentialReferenceRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const ownerId = typeof record.ownerId === "string" ? record.ownerId.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const updatedAt =
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt))
      ? record.updatedAt
      : "";
  if (
    (kind !== "hostPassword" &&
      kind !== "privateKeyPassphrase" &&
      kind !== "proxyPassword") ||
    !ownerId ||
    !label ||
    !updatedAt
  ) {
    return undefined;
  }
  return createCredentialReference(kind, ownerId, label, updatedAt);
}

function hostCredentialCandidate(host: HostRecord) {
  const label = `主机：${host.name}`;
  if (host.authMethod === "password") {
    return createCredentialReference("hostPassword", host.id, label);
  }
  if (host.authMethod === "privateKey" && !host.sshKeyId) {
    return createCredentialReference("privateKeyPassphrase", host.id, label);
  }
  return undefined;
}

export function buildCredentialCandidates(
  configuration: CredentialConfiguration,
) {
  const candidates = [
    ...configuration.hosts.flatMap((host) => {
      const candidate = hostCredentialCandidate(host);
      return candidate ? [candidate] : [];
    }),
    ...configuration.trash.flatMap(({ host }) => {
      const candidate = hostCredentialCandidate(host);
      return candidate ? [candidate] : [];
    }),
    ...configuration.history.flatMap((record) => {
      if (record.hostId) return [];
      const ownerId = quickCredentialOwnerId(record);
      if (record.authMethod === "password") {
        return [
          createCredentialReference(
            "hostPassword",
            ownerId,
            `快速连接：${record.username}@${record.address}:${record.port}`,
          ),
        ];
      }
      if (record.authMethod === "privateKey" && !record.sshKeyId) {
        return [
          createCredentialReference(
            "privateKeyPassphrase",
            ownerId,
            `快速连接：${record.username}@${record.address}:${record.port}`,
          ),
        ];
      }
      return [];
    }),
    ...configuration.sshKeys.map((sshKey) =>
      createCredentialReference(
        "privateKeyPassphrase",
        sshKey.id,
        `密钥：${sshKey.name}`,
      ),
    ),
    ...configuration.proxies.flatMap((proxy) =>
      proxy.username
        ? [
            createCredentialReference(
              "proxyPassword",
              proxy.id,
              `代理：${proxy.name}`,
            ),
          ]
        : [],
    ),
  ];

  return [...new Map(candidates.map((item) => [item.id, item])).values()];
}

export function reconcileCredentialReferences(
  registered: CredentialReferenceRecord[],
  candidates: CredentialReferenceRecord[],
  results: CredentialProbeResult[],
  now = new Date().toISOString(),
) {
  const existingIds = new Set(
    results
      .filter((result) => result.exists)
      .map((result) => credentialReferenceId(result.kind, result.ownerId)),
  );
  const labels = new Map(
    [...registered, ...candidates].map((item) => [item.id, item.label]),
  );
  return [...existingIds].flatMap((id) => {
    const separator = id.indexOf(":");
    const kind = id.slice(0, separator) as CredentialKind;
    const ownerId = id.slice(separator + 1);
    const label = labels.get(id);
    return label
      ? [createCredentialReference(kind, ownerId, label, now)]
      : [];
  });
}

export function orphanedCredentialReferences(
  references: CredentialReferenceRecord[],
  candidates: CredentialReferenceRecord[],
) {
  const linkedIds = new Set(candidates.map((item) => item.id));
  return references.filter((item) => !linkedIds.has(item.id));
}

export function credentialKindLabel(kind: CredentialKind) {
  switch (kind) {
    case "hostPassword":
      return "登录密码";
    case "privateKeyPassphrase":
      return "私钥口令";
    case "proxyPassword":
      return "代理密码";
  }
}
