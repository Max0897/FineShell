import { describe, expect, test } from "bun:test";
import {
  buildCredentialCandidates,
  createCredentialReference,
  orphanedCredentialReferences,
  reconcileCredentialReferences,
} from "./credential-registry";

describe("credential registry", () => {
  test("derives linked candidates without storing secret values", () => {
    const candidates = buildCredentialCandidates({
      hosts: [
        {
          id: "host-1",
          name: "生产机",
          address: "example.com",
          port: 22,
          username: "root",
          authMethod: "password",
          connectTimeoutSeconds: 10,
          keepAliveIntervalSeconds: 15,
          autoReconnect: true,
          maxReconnectAttempts: 3,
          localPortForwards: [],
          remotePortForwards: [],
          dynamicPortForwards: [],
        },
      ],
      history: [],
      proxies: [],
      sshKeys: [],
      trash: [],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "hostPassword:host-1",
        label: "主机：生产机",
      }),
    ]);
    expect(JSON.stringify(candidates)).not.toContain("secret");
  });

  test("keeps only credentials confirmed by the native keychain", () => {
    const linked = createCredentialReference(
      "hostPassword",
      "host-1",
      "主机：生产机",
    );
    const orphan = createCredentialReference(
      "proxyPassword",
      "proxy-old",
      "代理：已删除",
    );
    const reconciled = reconcileCredentialReferences(
      [orphan],
      [linked],
      [
        { kind: "hostPassword", ownerId: "host-1", exists: true },
        { kind: "proxyPassword", ownerId: "proxy-old", exists: true },
      ],
    );

    expect(orphanedCredentialReferences(reconciled, [linked])).toEqual([
      expect.objectContaining({ id: "proxyPassword:proxy-old" }),
    ]);
  });
});
