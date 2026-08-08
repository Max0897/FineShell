export function remoteParentPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

export function normalizeRemoteDirectoryPath(path: string) {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed.startsWith("/")) return null;
  const normalized = trimmed.replace(/\/+/g, "/");
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

export interface RemotePathBreadcrumb {
  label: string;
  path: string;
}

export function remotePathBreadcrumbs(path: string): RemotePathBreadcrumb[] {
  const normalized = normalizeRemoteDirectoryPath(path) ?? "/";
  const segments = normalized.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...segments.map((label, index) => ({
      label,
      path: `/${segments.slice(0, index + 1).join("/")}`,
    })),
  ];
}

export function addRemotePathHistory(
  history: string[],
  path: string,
  limit: number,
) {
  const normalized = normalizeRemoteDirectoryPath(path);
  if (!normalized) return history;
  return [normalized, ...history.filter((item) => item !== normalized)].slice(
    0,
    limit,
  );
}

export function setRemotePathBookmark(
  bookmarks: string[],
  path: string,
  bookmarked: boolean,
  limit: number,
) {
  const normalized = normalizeRemoteDirectoryPath(path);
  if (!normalized) return bookmarks;
  const remaining = bookmarks.filter((item) => item !== normalized);
  return bookmarked ? [normalized, ...remaining].slice(0, limit) : remaining;
}

export function matchRemoteDirectoryPaths(
  bookmarks: string[],
  history: string[],
  query: string,
  limit = 12,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...bookmarks, ...history]
    .filter(
      (path, index, paths) =>
        paths.indexOf(path) === index &&
        (!normalizedQuery || path.toLocaleLowerCase().includes(normalizedQuery)),
    )
    .slice(0, limit);
}

export function remoteJoinPath(directory: string, name: string) {
  const normalizedDirectory =
    normalizeRemoteDirectoryPath(directory) ??
    directory.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalizedDirectory === "/") return `/${name}`;
  return `${normalizedDirectory.replace(/\/+$/, "")}/${name}`;
}

export function isRemotePathDescendant(parent: string, candidate: string) {
  const normalizedParent =
    parent.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const normalizedCandidate =
    candidate.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalizedParent === "/") {
    return normalizedCandidate !== "/" && normalizedCandidate.startsWith("/");
  }
  return normalizedCandidate.startsWith(`${normalizedParent}/`);
}

export function nextAvailableRemoteName(
  name: string,
  unavailableNames: ReadonlySet<string>,
) {
  if (!unavailableNames.has(name)) return name;
  const extensionIndex = name.lastIndexOf(".");
  const hasExtension = extensionIndex > 0 && extensionIndex < name.length - 1;
  const base = hasExtension ? name.slice(0, extensionIndex) : name;
  const extension = hasExtension ? name.slice(extensionIndex) : "";
  let index = 1;
  let candidate = `${base} (${index})${extension}`;
  while (unavailableNames.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${extension}`;
  }
  return candidate;
}

export function localFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export interface NativeDropPoint {
  x: number;
  y: number;
  inside: boolean;
  coordinateMode: "logical" | "physical";
}

interface NativeDropPosition {
  x: number;
  y: number;
}

interface NativeDropBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function isPointInsideBounds(
  point: NativeDropPosition,
  bounds: NativeDropBounds,
) {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

export function resolveNativeDropPoint(
  position: NativeDropPosition,
  scaleFactor: number,
  bounds: NativeDropBounds,
  preferLogicalCoordinates: boolean,
): NativeDropPoint {
  const normalizedScaleFactor =
    Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const logical = { x: position.x, y: position.y };
  const physical = {
    x: position.x / normalizedScaleFactor,
    y: position.y / normalizedScaleFactor,
  };
  const candidates = preferLogicalCoordinates
    ? [
        { point: logical, coordinateMode: "logical" as const },
        { point: physical, coordinateMode: "physical" as const },
      ]
    : [
        { point: physical, coordinateMode: "physical" as const },
        { point: logical, coordinateMode: "logical" as const },
      ];
  const matched = candidates.find(({ point }) =>
    isPointInsideBounds(point, bounds),
  );
  const resolved = matched ?? candidates[0];
  return {
    ...resolved.point,
    inside: Boolean(matched),
    coordinateMode: resolved.coordinateMode,
  };
}

export function selectAllSftpEntryKeys(visibleKeys: readonly string[]) {
  return [...visibleKeys];
}

export function invertSftpEntryKeys(
  visibleKeys: readonly string[],
  selectedKeys: readonly string[],
) {
  const selected = new Set(selectedKeys);
  return visibleKeys.filter((key) => !selected.has(key));
}

export type SftpTransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export function isActiveSftpTransfer(status: SftpTransferStatus) {
  return status === "queued" || status === "running" || status === "paused";
}

export interface SftpTransferBatchSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  finished: boolean;
}

export function summarizeSftpTransferBatch(
  statuses: readonly SftpTransferStatus[],
): SftpTransferBatchSummary {
  const summary = statuses.reduce<SftpTransferBatchSummary>(
    (current, status) => {
      current.total += 1;
      if (status === "completed") current.completed += 1;
      else if (status === "failed") current.failed += 1;
      else if (status === "cancelled") current.cancelled += 1;
      else current.active += 1;
      return current;
    },
    {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      active: 0,
      finished: false,
    },
  );
  summary.finished = summary.total > 0 && summary.active === 0;
  return summary;
}

export function isValidRemoteName(name: string) {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0")
  );
}

export function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size < 0) return "-";
  if (size < 1024) return `${size} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatRemoteTime(timestamp?: number) {
  if (!timestamp) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function formatPermissions(permissions?: number) {
  if (permissions === undefined) return "-";
  return (permissions & 0o7777).toString(8).padStart(3, "0");
}

export function parsePermissions(value: string) {
  const normalized = value.trim();
  if (!/^[0-7]{3,4}$/.test(normalized)) return null;
  return Number.parseInt(normalized, 8);
}

export type RemoteArchiveFormat = "tarGz" | "tar" | "zip";

const REMOTE_ARCHIVE_SUFFIXES: Array<{
  format: RemoteArchiveFormat;
  suffix: string;
}> = [
  { format: "tarGz", suffix: ".tar.gz" },
  { format: "tarGz", suffix: ".tgz" },
  { format: "tar", suffix: ".tar" },
  { format: "zip", suffix: ".zip" },
];

export function remoteArchiveExtension(format: RemoteArchiveFormat) {
  return format === "tarGz" ? ".tar.gz" : `.${format}`;
}

export function remoteArchiveFormatFromName(name: string) {
  const normalized = name.toLocaleLowerCase();
  return (
    REMOTE_ARCHIVE_SUFFIXES.find(({ suffix }) =>
      normalized.endsWith(suffix),
    )?.format ?? null
  );
}

export function remoteArchiveBaseName(name: string) {
  const normalized = name.toLocaleLowerCase();
  const suffix = REMOTE_ARCHIVE_SUFFIXES.find(({ suffix }) =>
    normalized.endsWith(suffix),
  )?.suffix;
  if (!suffix) return name;
  return name.slice(0, -suffix.length) || "archive";
}

export function remoteArchiveFileName(
  baseName: string,
  format: RemoteArchiveFormat,
) {
  return `${remoteArchiveBaseName(baseName)}${remoteArchiveExtension(format)}`;
}

export function nextAvailableRemoteArchiveName(
  baseName: string,
  format: RemoteArchiveFormat,
  unavailableNames: ReadonlySet<string>,
) {
  const normalizedBase = remoteArchiveBaseName(baseName) || "archive";
  let candidate = remoteArchiveFileName(normalizedBase, format);
  let index = 1;
  while (unavailableNames.has(candidate)) {
    candidate = remoteArchiveFileName(`${normalizedBase} (${index})`, format);
    index += 1;
  }
  return candidate;
}

export const PERMISSION_FLAGS = [
  { mask: 0o400, value: "owner-read" },
  { mask: 0o200, value: "owner-write" },
  { mask: 0o100, value: "owner-execute" },
  { mask: 0o040, value: "group-read" },
  { mask: 0o020, value: "group-write" },
  { mask: 0o010, value: "group-execute" },
  { mask: 0o004, value: "other-read" },
  { mask: 0o002, value: "other-write" },
  { mask: 0o001, value: "other-execute" },
] as const;

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number]["value"];

export function permissionFlagsFromValue(permissions: number) {
  return PERMISSION_FLAGS.filter(
    ({ mask }) => (permissions & mask) === mask,
  ).map(({ value }) => value);
}

export function permissionValueFromFlags(
  flags: readonly PermissionFlag[],
  currentPermissions = 0,
) {
  const selectedFlags = new Set<PermissionFlag>(flags);
  const standardPermissions = PERMISSION_FLAGS.reduce(
    (permissions, { mask, value }) =>
      selectedFlags.has(value) ? permissions | mask : permissions,
    0,
  );
  return (currentPermissions & 0o7000) | standardPermissions;
}
