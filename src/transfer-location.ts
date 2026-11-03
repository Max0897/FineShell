import { isApplePlatform } from "./platform-utils";
import { remoteParentPath } from "./sftp-utils";

export const TRANSFER_LOCATION_MAX_LENGTH = 44;

interface TransferLocationSource {
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
}

export interface TransferLocation {
  /** Directory the file was transferred into, shortened for display. */
  label: string;
  /** Untruncated path of the destination file. */
  fullPath: string;
}

export function localParentPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return trimmed;
  // Keep the root separator for "/file" and "C:\file".
  if (separator === 0 || /^[A-Za-z]:$/.test(trimmed.slice(0, separator))) {
    return trimmed.slice(0, separator + 1);
  }
  return trimmed.slice(0, separator);
}

export function abbreviateHomePath(path: string, homeDirectory?: string) {
  const home = homeDirectory?.replace(/[\\/]+$/, "");
  if (!home) return path;
  if (path === home) return "~";
  const rest = path.slice(home.length);
  if (path.startsWith(home) && /^[\\/]/.test(rest)) return `~${rest}`;
  return path;
}

/** Shortens a path by eliding its middle, which matters least for orientation. */
export function middleTruncatePath(
  path: string,
  maxLength = TRANSFER_LOCATION_MAX_LENGTH,
) {
  const characters = Array.from(path);
  if (characters.length <= maxLength) return path;
  const available = maxLength - 1;
  const tailLength = Math.ceil(available * 0.6);
  const headLength = available - tailLength;
  return `${characters.slice(0, headLength).join("")}…${characters
    .slice(characters.length - tailLength)
    .join("")}`;
}

export function transferLocation(
  transfer: TransferLocationSource,
  homeDirectory?: string,
): TransferLocation {
  if (transfer.direction === "upload") {
    return {
      label: middleTruncatePath(remoteParentPath(transfer.remotePath)),
      fullPath: transfer.remotePath,
    };
  }
  return {
    label: middleTruncatePath(
      abbreviateHomePath(localParentPath(transfer.localPath), homeDirectory),
    ),
    fullPath: transfer.localPath,
  };
}

export function canRevealLocalTransfer(transfer: {
  direction: "upload" | "download";
  status: string;
}) {
  return transfer.direction === "download" && transfer.status === "completed";
}

export function revealInFileManagerLabel(platform: string = navigator.platform) {
  return isApplePlatform(platform) ? "在访达中显示" : "在文件夹中显示";
}
