import type { HostRecord, HostSortMode } from "./models";

const HOST_GROUP_KEY_PREFIX = "host-group:";

export interface HostTableGroupRow {
  id: string;
  type: "group";
  name: string;
  path: string;
  count: number;
  children: HostTableRow[];
}

export interface HostTableHostRow {
  id: string;
  type: "host";
  name: string;
  host: HostRecord;
}

export type HostTableRow = HostTableGroupRow | HostTableHostRow;

interface MutableHostGroupRow {
  id: string;
  name: string;
  path: string;
  count: number;
  groups: Map<string, MutableHostGroupRow>;
  hosts: HostRecord[];
}

export function normalizeGroupPath(group?: string) {
  const normalized = group
    ?.split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return normalized || undefined;
}

export function collectHostGroupPaths(hosts: HostRecord[]) {
  const paths = new Set<string>();
  for (const host of hosts) {
    const group = normalizeGroupPath(host.group);
    if (!group) continue;

    let currentPath = "";
    for (const segment of group.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      paths.add(currentPath);
    }
  }
  return [...paths].sort((left, right) =>
    left.localeCompare(right, "zh-CN", { numeric: true }),
  );
}

export function hostGroupKey(path: string) {
  return `${HOST_GROUP_KEY_PREFIX}${path}`;
}

function hostTableRow(host: HostRecord): HostTableHostRow {
  return {
    id: `host:${host.id}`,
    type: "host",
    name: host.name,
    host,
  };
}

function finalizeGroupRows(
  groups: Iterable<MutableHostGroupRow>,
): HostTableGroupRow[] {
  return Array.from(groups)
    .sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
    )
    .map((group) => ({
      id: group.id,
      type: "group",
      name: group.name,
      path: group.path,
      count: group.count,
      children: [
        ...finalizeGroupRows(group.groups.values()),
        ...group.hosts.map(hostTableRow),
      ],
    }));
}

export function buildHostTableTree(hosts: HostRecord[]): HostTableRow[] {
  const rootGroups = new Map<string, MutableHostGroupRow>();
  const rootHosts: HostRecord[] = [];

  for (const host of hosts) {
    const group = normalizeGroupPath(host.group);
    if (!group) {
      rootHosts.push(host);
      continue;
    }

    let currentLevel = rootGroups;
    let currentGroup: MutableHostGroupRow | undefined;
    let currentPath = "";
    for (const segment of group.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let groupRow = currentLevel.get(segment);
      if (!groupRow) {
        groupRow = {
          id: hostGroupKey(currentPath),
          name: segment,
          path: currentPath,
          count: 0,
          groups: new Map(),
          hosts: [],
        };
        currentLevel.set(segment, groupRow);
      }
      groupRow.count += 1;
      currentGroup = groupRow;
      currentLevel = groupRow.groups;
    }
    currentGroup?.hosts.push(host);
  }

  return [
    ...finalizeGroupRows(rootGroups.values()),
    ...rootHosts.map(hostTableRow),
  ];
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

export function createHostCopy(
  source: HostRecord,
  existingHosts: HostRecord[],
  id: string,
): HostRecord {
  const existingNames = new Set(existingHosts.map((host) => host.name));
  const baseName = `${source.name} 副本`;
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName} ${suffix}`;
    suffix += 1;
  }

  const { lastConnectedAt: _lastConnectedAt, ...metadata } = source;
  return { ...metadata, id, name };
}
