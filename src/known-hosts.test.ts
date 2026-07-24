import { describe, expect, test } from "bun:test";
import {
  deriveKnownHostRecords,
  normalizeHostFingerprint,
  removeKnownHostTrust,
  upsertKnownHostRecord,
} from "./known-hosts";
import type { ConnectionHistoryRecord, HostRecord } from "./models";

const HOST: HostRecord = {
  id: "host-1",
  name: "Server",
  address: "server.example.com",
  port: 22,
  username: "root",
  authMethod: "password",
  connectTimeoutSeconds: 10,
  keepAliveIntervalSeconds: 15,
  autoReconnect: true,
  maxReconnectAttempts: 3,
};

describe("known host fingerprints", () => {
  test("normalizes SHA256 fingerprints", () => {
    expect(normalizeHostFingerprint(" abc123 ")).toBe("SHA256:abc123");
    expect(normalizeHostFingerprint("SHA256:abc123")).toBe(
      "SHA256:abc123",
    );
  });

  test("keeps the first seen time while refreshing the same fingerprint", () => {
    const first = upsertKnownHostRecord(
      [],
      HOST,
      "SHA256:first",
      "2026-07-20T00:00:00.000Z",
    );
    const refreshed = upsertKnownHostRecord(
      first,
      HOST,
      "SHA256:first",
      "2026-07-22T00:00:00.000Z",
    );

    expect(refreshed[0].firstSeenAt).toBe("2026-07-20T00:00:00.000Z");
    expect(refreshed[0].lastVerifiedAt).toBe("2026-07-22T00:00:00.000Z");
  });

  test("starts a new trust period when the fingerprint changes", () => {
    const first = upsertKnownHostRecord(
      [],
      HOST,
      "SHA256:first",
      "2026-07-20T00:00:00.000Z",
    );
    const changed = upsertKnownHostRecord(
      first,
      HOST,
      "SHA256:second",
      "2026-07-22T00:00:00.000Z",
    );

    expect(changed[0].fingerprint).toBe("SHA256:second");
    expect(changed[0].firstSeenAt).toBe("2026-07-22T00:00:00.000Z");
  });

  test("migrates the most recently verified fingerprint per endpoint", () => {
    const history: ConnectionHistoryRecord[] = [
      {
        id: "history-1",
        name: "Server",
        address: "SERVER.example.com",
        port: 22,
        username: "deploy",
        connectedAt: "2026-07-22T00:00:00.000Z",
        hostFingerprint: "SHA256:new",
      },
    ];
    const records = deriveKnownHostRecords(
      [
        {
          ...HOST,
          hostFingerprint: "SHA256:old",
          lastConnectedAt: "2026-07-20T00:00:00.000Z",
        },
      ],
      history,
    );

    expect(records).toHaveLength(1);
    expect(records[0].fingerprint).toBe("SHA256:new");
    expect(records[0].firstSeenAt).toBe("2026-07-22T00:00:00.000Z");
  });

  test("clears trust from every account using the removed endpoint", () => {
    const records = upsertKnownHostRecord(
      [],
      HOST,
      "SHA256:first",
      "2026-07-20T00:00:00.000Z",
    );
    const result = removeKnownHostTrust(
      records,
      [
        { ...HOST, hostFingerprint: "SHA256:first" },
        {
          ...HOST,
          id: "host-2",
          username: "deploy",
          hostFingerprint: "SHA256:first",
        },
      ],
      [
        {
          id: "history-1",
          name: "Server",
          address: "SERVER.example.com",
          port: 22,
          username: "admin",
          connectedAt: "2026-07-20T00:00:00.000Z",
          hostFingerprint: "SHA256:first",
        },
      ],
      [records[0].id],
    );

    expect(result.knownHosts).toEqual([]);
    expect(result.hosts.every((host) => !host.hostFingerprint)).toBe(true);
    expect(result.history[0].hostFingerprint).toBeUndefined();
  });
});
