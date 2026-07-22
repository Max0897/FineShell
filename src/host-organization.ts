import type { HostRecord, HostSortMode } from "./models";

export const ALL_HOSTS_GROUP_KEY = "all-hosts";
export const UNGROUPED_HOSTS_GROUP_KEY = "ungrouped-hosts";
const HOST_GROUP_KEY_PREFIX = "host-group:";

export interface HostGroupTreeNode {
  key: string;
  title: string;
  count: number;
  children?: HostGroupTreeNode[];
}

interface MutableHostGroupNode {
  key: string;
  title: string;
  count: number;
  children: Map<string, MutableHostGroupNode>;
}

export function normalizeGroupPath(group?: string) {
  const normalized = group
    ?.split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return normalized || undefined;
}

export function hostGroupKey(path: string) {
  return `${HOST_GROUP_KEY_PREFIX}${path}`;
}

function finalizeGroupNodes(
  nodes: Iterable<MutableHostGroupNode>,
): HostGroupTreeNode[] {
  return Array.from(nodes)
    .sort((left, right) =>
      left.title.localeCompare(right.title, "zh-CN", { numeric: true }),
    )
    .map((node) => {
      const children = finalizeGroupNodes(node.children.values());
      return {
        key: node.key,
        title: node.title,
        count: node.count,
        children: children.length ? children : undefined,
      };
    });
}

export function buildHostGroupTree(hosts: HostRecord[]): HostGroupTreeNode[] {
  const roots = new Map<string, MutableHostGroupNode>();
  let ungroupedCount = 0;

  for (const host of hosts) {
    const group = normalizeGroupPath(host.group);
    if (!group) {
      ungroupedCount += 1;
      continue;
    }

    let currentLevel = roots;
    let currentPath = "";
    for (const segment of group.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let node = currentLevel.get(segment);
      if (!node) {
        node = {
          key: hostGroupKey(currentPath),
          title: segment,
          count: 0,
          children: new Map(),
        };
        currentLevel.set(segment, node);
      }
      node.count += 1;
      currentLevel = node.children;
    }
  }

  return [
    { key: ALL_HOSTS_GROUP_KEY, title: "全部主机", count: hosts.length },
    {
      key: UNGROUPED_HOSTS_GROUP_KEY,
      title: "未分组",
      count: ungroupedCount,
    },
    ...finalizeGroupNodes(roots.values()),
  ];
}

export function filterHostsByGroup(
  hosts: HostRecord[],
  selectedGroupKey: string,
) {
  if (selectedGroupKey === ALL_HOSTS_GROUP_KEY) return hosts;
  if (selectedGroupKey === UNGROUPED_HOSTS_GROUP_KEY) {
    return hosts.filter((host) => !normalizeGroupPath(host.group));
  }
  if (!selectedGroupKey.startsWith(HOST_GROUP_KEY_PREFIX)) return hosts;

  const selectedPath = selectedGroupKey.slice(HOST_GROUP_KEY_PREFIX.length);
  return hosts.filter((host) => {
    const group = normalizeGroupPath(host.group);
    return group === selectedPath || group?.startsWith(`${selectedPath}/`);
  });
}

export function collectHostGroupKeys(nodes: HostGroupTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.key.startsWith(HOST_GROUP_KEY_PREFIX) ? [node.key] : []),
    ...collectHostGroupKeys(node.children ?? []),
  ]);
}

function compareHostNames(left: HostRecord, right: HostRecord) {
  return (
    left.name.localeCompare(right.name, "zh-CN", { numeric: true }) ||
    left.id.localeCompare(right.id)
  );
}

export function sortHosts(hosts: HostRecord[], mode: HostSortMode) {
  if (mode === "manual") return hosts;

  return [...hosts].sort((left, right) => {
    if (mode === "nameAsc") return compareHostNames(left, right);
    if (mode === "nameDesc") return compareHostNames(right, left);
    if (mode === "addressAsc") {
      return (
        left.address.localeCompare(right.address, "en", { numeric: true }) ||
        left.port - right.port ||
        compareHostNames(left, right)
      );
    }

    const leftTime = left.lastConnectedAt
      ? Date.parse(left.lastConnectedAt)
      : Number.NEGATIVE_INFINITY;
    const rightTime = right.lastConnectedAt
      ? Date.parse(right.lastConnectedAt)
      : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime || compareHostNames(left, right);
  });
}
