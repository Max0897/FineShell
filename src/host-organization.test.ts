import { describe, expect, test } from "bun:test";
import type { HostRecord } from "./models";
import {
  buildHostTableTree,
  createHostCopy,
  hostGroupKey,
  normalizeGroupPath,
  sortHosts,
} from "./host-organization";

function host(id: string, group?: string): HostRecord {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    port: 22,
    username: "root",
    authMethod: "password",
    connectTimeoutSeconds: 10,
    keepAliveIntervalSeconds: 15,
    autoReconnect: true,
    maxReconnectAttempts: 3,
    group,
  };
}

describe("host group organization", () => {
  const hosts = [
    host("prod-east", "生产 / 华东"),
    host("prod-west", "生产/华西"),
    host("test", "测试"),
    host("local"),
  ];

  test("normalizes nested group paths", () => {
    expect(normalizeGroupPath(" 生产 / 华东 / ")).toBe("生产/华东");
    expect(normalizeGroupPath(" / / ")).toBeUndefined();
  });

  test("builds grouped table rows and keeps ungrouped hosts at root", () => {
    expect(buildHostTableTree(hosts)).toEqual([
      {
        id: hostGroupKey("测试"),
        type: "group",
        name: "测试",
        path: "测试",
        count: 1,
        children: [
          {
            id: "host:test",
            type: "host",
            name: "test",
            host: hosts[2],
          },
        ],
      },
      {
        id: hostGroupKey("生产"),
        type: "group",
        name: "生产",
        path: "生产",
        count: 2,
        children: [
          {
            id: hostGroupKey("生产/华东"),
            type: "group",
            name: "华东",
            path: "生产/华东",
            count: 1,
            children: [
              {
                id: "host:prod-east",
                type: "host",
                name: "prod-east",
                host: hosts[0],
              },
            ],
          },
          {
            id: hostGroupKey("生产/华西"),
            type: "group",
            name: "华西",
            path: "生产/华西",
            count: 1,
            children: [
              {
                id: "host:prod-west",
                type: "host",
                name: "prod-west",
                host: hosts[1],
              },
            ],
          },
        ],
      },
      {
        id: "host:local",
        type: "host",
        name: "local",
        host: hosts[3],
      },
    ]);
  });
});

describe("host sorting", () => {
  const hosts = [
    { ...host("server-10"), name: "Server 10", address: "10.0.0.10" },
    {
      ...host("server-2"),
      name: "Server 2",
      address: "10.0.0.2",
      lastConnectedAt: "2026-07-22T10:00:00.000Z",
    },
    { ...host("alpha"), name: "Alpha", address: "192.168.1.1" },
  ];

  test("keeps stored order in manual mode", () => {
    expect(sortHosts(hosts, "manual")).toBe(hosts);
  });

  test("sorts names naturally in both directions", () => {
    expect(sortHosts(hosts, "nameAsc").map((item) => item.name)).toEqual([
      "Alpha",
      "Server 2",
      "Server 10",
    ]);
    expect(sortHosts(hosts, "nameDesc").map((item) => item.name)).toEqual([
      "Server 10",
      "Server 2",
      "Alpha",
    ]);
  });

  test("sorts addresses naturally and recent connections first", () => {
    expect(sortHosts(hosts, "addressAsc").map((item) => item.id)).toEqual([
      "server-2",
      "server-10",
      "alpha",
    ]);
    expect(sortHosts(hosts, "recentDesc")[0].id).toBe("server-2");
  });
});

describe("host copy", () => {
  test("creates a new identity and a unique name", () => {
    const source = {
      ...host("source", "生产/华东"),
      name: "Application",
      hostFingerprint: "SHA256:fingerprint",
      lastConnectedAt: "2026-07-22T10:00:00.000Z",
    };
    const copied = createHostCopy(
      source,
      [source, { ...host("copy"), name: "Application 副本" }],
      "new-id",
    );

    expect(copied.id).toBe("new-id");
    expect(copied.name).toBe("Application 副本 2");
    expect(copied.group).toBe("生产/华东");
    expect(copied.hostFingerprint).toBe("SHA256:fingerprint");
    expect(copied.lastConnectedAt).toBeUndefined();
  });
});
