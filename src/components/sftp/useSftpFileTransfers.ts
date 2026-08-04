import { Message } from "@arco-design/web-react";
import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpEntry, SftpListResult } from "../../models";
import { remoteJoinPath } from "../../sftp-utils";
import { commandErrorMessage } from "../../tauri-protocol";
import useNativeSftpDrop from "./useNativeSftpDrop";

interface LocalUploadFile {
  path: string;
  relativePath: string;
  size: number;
}

interface LocalUploadInspection {
  files: LocalUploadFile[];
  directories: string[];
  skippedPaths: number;
}

interface QueueTransferOptions {
  batchId?: string;
  direction: "upload" | "download";
  localPath: string;
  overwrite: boolean;
  remotePath: string;
  sessionId: string;
  totalBytes?: number;
}

interface SftpFileTransfersOptions {
  confirmOverwrite: (title: string, content: string) => Promise<boolean>;
  currentDirectory?: string;
  entries: SftpEntry[];
  onClearSelection: () => void;
  onQueueTransfer: (options: QueueTransferOptions) => void;
  onRefreshDirectory: () => void | Promise<void>;
  ready: boolean;
  sessionId?: string;
}

function createUploadBatchId() {
  return `upload-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function useSftpFileTransfers({
  confirmOverwrite,
  currentDirectory,
  entries,
  onClearSelection,
  onQueueTransfer,
  onRefreshDirectory,
  ready,
  sessionId,
}: SftpFileTransfersOptions) {
  async function queueUploadPaths(paths: string[], targetDirectory?: string) {
    if (!sessionId || !currentDirectory || !ready) return;
    let inspection: LocalUploadInspection;
    try {
      inspection = await invoke<LocalUploadInspection>(
        "sftp_inspect_upload_paths",
        { paths },
      );
    } catch (error) {
      Message.error(commandErrorMessage(error));
      return;
    }
    if (inspection.skippedPaths > 0) {
      Message.warning(`已跳过 ${inspection.skippedPaths} 个无效或不支持的项目`);
    }
    if (inspection.files.length === 0 && inspection.directories.length === 0) {
      Message.warning("没有可上传的文件或文件夹");
      return;
    }

    const destination = targetDirectory ?? currentDirectory;
    let targetEntries = entries;
    if (destination !== currentDirectory) {
      try {
        const listing = await invoke<SftpListResult>("sftp_list", {
          sessionId,
          path: destination,
        });
        targetEntries = listing.entries;
      } catch (error) {
        Message.error(commandErrorMessage(error));
        return;
      }
    }

    const directoryRoots = new Set(
      inspection.directories.filter((path) => !path.includes("/")),
    );
    const rootNames = new Set([
      ...directoryRoots,
      ...inspection.files.map((file) => file.relativePath.split("/")[0]),
    ]);
    const existingEntries = new Map(
      targetEntries.map((entry) => [entry.name, entry]),
    );
    const incompatibleRoot = [...rootNames].find((name) => {
      const existing = existingEntries.get(name);
      return (
        existing &&
        (directoryRoots.has(name) !== (existing.kind === "directory"))
      );
    });
    if (incompatibleRoot) {
      Message.error(`远程目标“${incompatibleRoot}”与本地项目类型不一致`);
      return;
    }

    const conflictingRoots = new Set(
      [...rootNames].filter((name) => existingEntries.has(name)),
    );
    if (
      conflictingRoots.size > 0 &&
      !(await confirmOverwrite(
        "合并或覆盖远程项目？",
        `有 ${conflictingRoots.size} 个同名项目，目录将合并，同名文件将覆盖。`,
      ))
    ) {
      return;
    }

    try {
      await invoke("sftp_ensure_upload_directories", {
        sessionId,
        basePath: destination,
        relativePaths: inspection.directories,
      });
    } catch (error) {
      Message.error(commandErrorMessage(error));
      return;
    }

    const batchId =
      inspection.files.length > 1 ? createUploadBatchId() : undefined;
    for (const file of inspection.files) {
      const rootName = file.relativePath.split("/")[0];
      onQueueTransfer({
        batchId,
        direction: "upload",
        localPath: file.path,
        overwrite: conflictingRoots.has(rootName),
        remotePath: remoteJoinPath(destination, file.relativePath),
        sessionId,
        totalBytes: file.size,
      });
    }
    if (
      destination === currentDirectory &&
      inspection.directories.length > 0 &&
      inspection.files.length === 0
    ) {
      await onRefreshDirectory();
    }
    if (inspection.files.length > 0) {
      Message.info(`已加入 ${inspection.files.length} 个上传任务`);
    } else {
      Message.success(`已创建 ${inspection.directories.length} 个目录`);
    }
  }

  const {
    active: fileDropActive,
    dropZoneRef,
    targetPath: fileDropTargetPath,
  } = useNativeSftpDrop({
    onUploadPaths: queueUploadPaths,
    ready,
  });

  async function chooseUploadFiles() {
    if (!sessionId || !currentDirectory || !ready) return;
    const selected = await open({
      directory: false,
      multiple: true,
      title: "选择上传文件（可多选）",
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (paths.length > 0) {
      await queueUploadPaths(paths);
    }
  }

  async function downloadEntry(entry: SftpEntry) {
    if (!sessionId || !ready) return;
    const target = await save({
      defaultPath: entry.name,
      title: `下载 ${entry.name}`,
    });
    if (!target) return;
    onQueueTransfer({
      direction: "download",
      localPath: target,
      overwrite: true,
      remotePath: entry.path,
      sessionId,
      totalBytes: entry.size,
    });
  }

  async function downloadEntries(targetEntries: SftpEntry[]) {
    if (!sessionId || !ready) return;
    const files = targetEntries.filter((entry) => entry.kind !== "directory");
    if (files.length === 0) {
      Message.warning("请选择需要下载的文件");
      return;
    }
    if (files.length < targetEntries.length) {
      Message.warning(`已跳过 ${targetEntries.length - files.length} 个目录`);
    }
    if (files.length === 1) {
      await downloadEntry(files[0]);
      return;
    }
    const targetDirectory = await open({
      directory: true,
      multiple: false,
      title: `选择 ${files.length} 个文件的下载目录`,
    });
    if (typeof targetDirectory !== "string") return;
    if (
      !(await confirmOverwrite(
        "开始批量下载？",
        `将下载 ${files.length} 个文件，同名本地文件将统一覆盖。`,
      ))
    ) {
      return;
    }

    for (const entry of files) {
      onQueueTransfer({
        direction: "download",
        localPath: await join(targetDirectory, entry.name),
        overwrite: true,
        remotePath: entry.path,
        sessionId,
        totalBytes: entry.size,
      });
    }
    onClearSelection();
    Message.info(`已加入 ${files.length} 个下载任务`);
  }

  return {
    chooseUploadFiles,
    downloadEntries,
    downloadEntry,
    dropZoneRef,
    fileDropActive,
    fileDropTargetPath,
  };
}
