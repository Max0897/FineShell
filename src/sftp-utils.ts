export function remoteParentPath(path: string) {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

export function normalizeRemoteDirectoryPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
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
  if (directory === "/") return `/${name}`;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function isRemotePathDescendant(parent: string, candidate: string) {
  const normalizedParent = parent.replace(/\/+$/, "") || "/";
  const normalizedCandidate = candidate.replace(/\/+$/, "") || "/";
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
