import { describe, expect, test } from "bun:test";
import type { HostRecord } from "./models";
import {
  ALL_HOSTS_GROUP_KEY,
  buildHostGroupTree,
  filterHostsByGroup,
  hostGroupKey,
  normalizeGroupPath,
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
