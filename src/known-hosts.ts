import type {
  ConnectionHistoryRecord,
  HostRecord,
  KnownHostRecord,
} from "./models";

interface KnownHostTarget {
  address: string;
  port: number;
}

function validTimestamp(value: string | undefined, fallback: string) {
  return value && Number.isFinite(Date.parse(value)) ? value : fallback;
}

export function normalizeHostFingerprint(value: string) {
  const fingerprint = value.trim();
  if (!fingerprint) return "";
  return fingerprint.startsWith("SHA256:")
    ? fingerprint
    : `SHA256:${fingerprint}`;
}

export function knownHostTargetKey(address: string, port: number) {
  return `${address.trim().toLowerCase()}:${port}`;
}

export function knownHostRecordId(address: string, port: number) {
  return `known-host-${encodeURIComponent(knownHostTargetKey(address, port))}`;
}

export function upsertKnownHostRecord(
  records: KnownHostRecord[],
  target: KnownHostTarget,
  fingerprint: string,
  verifiedAt = new Date().toISOString(),
) {
  const normalizedFingerprint = normalizeHostFingerprint(fingerprint);
  const key = knownHostTargetKey(target.address, target.port);
  const existing = records.find(
    (record) => knownHostTargetKey(record.address, record.port) === key,
  );
  const fingerprintChanged =
    existing && existing.fingerprint !== normalizedFingerprint;
  const next: KnownHostRecord = {
    id: existing?.id ?? knownHostRecordId(target.address, target.port),
    address: target.address.trim(),
    port: target.port,
    fingerprint: normalizedFingerprint,
    firstSeenAt:
      existing && !fingerprintChanged ? existing.firstSeenAt : verifiedAt,
    lastVerifiedAt: verifiedAt,
  };

  return existing
    ? records.map((record) => (record.id === existing.id ? next : record))
    : [...records, next];
}

export function deriveKnownHostRecords(
  hosts: HostRecord[],
  history: ConnectionHistoryRecord[],
  fallbackTime = new Date().toISOString(),
) {
  let records: KnownHostRecord[] = [];
  const candidates = [
    ...hosts.flatMap((host) =>
      host.hostFingerprint
        ? [
            {
              address: host.address,
              port: host.port,
              fingerprint: host.hostFingerprint,
              verifiedAt: validTimestamp(host.lastConnectedAt, fallbackTime),
            },
          ]
        : [],
    ),
    ...history.flatMap((record) =>
      record.hostFingerprint
        ? [
            {
              address: record.address,
              port: record.port,
              fingerprint: record.hostFingerprint,
              verifiedAt: validTimestamp(record.connectedAt, fallbackTime),
            },
          ]
        : [],
    ),
  ].sort(
    (left, right) =>
      Date.parse(left.verifiedAt) - Date.parse(right.verifiedAt),
  );

  for (const candidate of candidates) {
    const key = knownHostTargetKey(candidate.address, candidate.port);
    const existing = records.find(
      (record) => knownHostTargetKey(record.address, record.port) === key,
    );
    const previousFirstSeenAt = existing?.firstSeenAt;
    records = upsertKnownHostRecord(
      records,
      candidate,
      candidate.fingerprint,
      candidate.verifiedAt,
    );
    if (
      existing &&
      previousFirstSeenAt &&
      existing.fingerprint === normalizeHostFingerprint(candidate.fingerprint)
    ) {
      records = records.map((record) =>
        record.id === existing.id
          ? { ...record, firstSeenAt: previousFirstSeenAt }
          : record,
      );
    }
  }

  return records.sort(
    (left, right) =>
      Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt),
  );
}

export function removeKnownHostTrust(
  records: KnownHostRecord[],
  hosts: HostRecord[],
  history: ConnectionHistoryRecord[],
  recordIds: string[],
) {
  const ids = new Set(recordIds);
  const removedTargets = new Set(
    records
      .filter((record) => ids.has(record.id))
      .map((record) => knownHostTargetKey(record.address, record.port)),
  );
  return {
    knownHosts: records.filter((record) => !ids.has(record.id)),
    hosts: hosts.map((host) =>
      removedTargets.has(knownHostTargetKey(host.address, host.port))
        ? { ...host, hostFingerprint: undefined }
        : host,
    ),
    history: history.map((record) =>
      removedTargets.has(knownHostTargetKey(record.address, record.port))
        ? { ...record, hostFingerprint: undefined }
        : record,
    ),
  };
}
