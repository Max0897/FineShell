export function remoteParentPath(path: string) {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

export function remoteJoinPath(directory: string, name: string) {
  if (directory === "/") return `/${name}`;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function localFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
