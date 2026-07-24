import type {
  ConnectionHistoryLimit,
  ConnectionHistoryRetentionDays,
} from "./app-settings";
import type { ConnectionHistoryRecord } from "./models";

export interface ConnectionHistoryPolicy {
  connectionHistoryLimit: ConnectionHistoryLimit;
  connectionHistoryRetentionDays: ConnectionHistoryRetentionDays;
}

export function applyConnectionHistoryPolicy(
  history: ConnectionHistoryRecord[],
  policy: ConnectionHistoryPolicy,
  now = new Date(),
) {
  const cutoff = policy.connectionHistoryRetentionDays
    ? now.getTime() -
      policy.connectionHistoryRetentionDays * 24 * 60 * 60 * 1_000
    : Number.NEGATIVE_INFINITY;
  const retained = history
    .filter((record) => {
      const connectedAt = Date.parse(record.connectedAt);
      return Number.isFinite(connectedAt) && connectedAt >= cutoff;
    })
    .sort(
      (left, right) =>
        Date.parse(right.connectedAt) - Date.parse(left.connectedAt),
    );

  return policy.connectionHistoryLimit === 0
    ? retained
    : retained.slice(0, policy.connectionHistoryLimit);
}
