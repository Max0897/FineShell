import { describe, expect, test } from "bun:test";
import type { HostRecord } from "./models";
import {
  ALL_HOSTS_GROUP_KEY,
  buildHostGroupTree,
  filterHostsByGroup,
  hostGroupKey,
  normalizeGroupPath,
  sortHosts,
  UNGROUPED_HOSTS_GROUP_KEY,
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

  test("builds a counted hierarchy", () => {
    expect(buildHostGroupTree(hosts)).toEqual([
      { key: ALL_HOSTS_GROUP_KEY, title: "全部主机", count: 4 },
      { key: UNGROUPED_HOSTS_GROUP_KEY, title: "未分组", count: 1 },
      {
        key: hostGroupKey("测试"),
        title: "测试",
        count: 1,
        children: undefined,
      },
      {
        key: hostGroupKey("生产"),
        title: "生产",
        count: 2,
        children: [
          {
            key: hostGroupKey("生产/华东"),
            title: "华东",
            count: 1,
            children: undefined,
          },
          {
            key: hostGroupKey("生产/华西"),
            title: "华西",
            count: 1,
            children: undefined,
          },
        ],
      },
    ]);
  });

  test("filters parent groups with their descendants", () => {
    expect(filterHostsByGroup(hosts, hostGroupKey("生产"))).toHaveLength(2);
    expect(filterHostsByGroup(hosts, hostGroupKey("生产/华东"))[0].id).toBe(
      "prod-east",
    );
    expect(filterHostsByGroup(hosts, UNGROUPED_HOSTS_GROUP_KEY)[0].id).toBe(
      "local",
    );
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
