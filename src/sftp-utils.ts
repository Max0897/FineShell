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

export type SftpTransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface SftpTransferProgress {
  status: SftpTransferStatus;
  transferredBytes: number;
  totalBytes: number;
}

export function isActiveSftpTransfer(status: SftpTransferStatus) {
  return status === "queued" || status === "running" || status === "paused";
}

export function summarizeSftpTransfers(transfers: SftpTransferProgress[]) {
  const active = transfers.filter((transfer) =>
    isActiveSftpTransfer(transfer.status),
  ).length;
  const completed = transfers.filter(
    (transfer) => transfer.status === "completed",
  ).length;
  const totalBytes = transfers.reduce(
    (total, transfer) => total + Math.max(0, transfer.totalBytes),
    0,
  );
  const transferredBytes = transfers.reduce(
    (total, transfer) =>
      total +
      Math.min(
        Math.max(0, transfer.transferredBytes),
        Math.max(0, transfer.totalBytes),
      ),
    0,
  );
  return {
    active,
    completed,
    percent: totalBytes
      ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
      : 0,
    totalBytes,
    transferredBytes,
  };
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
