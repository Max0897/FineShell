import { useState } from "react";
import { Message } from "@arco-design/web-react";
import { save } from "@tauri-apps/plugin-dialog";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpEntry } from "../../models";
import {
  isValidRemoteName,
  nextAvailableRemoteArchiveName,
  remoteArchiveBaseName,
  remoteArchiveFileName,
  remoteArchiveFormatFromName,
  remoteJoinPath,
  type RemoteArchiveFormat,
} from "../../sftp-utils";
import type { ArchiveDialogState } from "./SftpDialogs";

interface SftpArchivesOptions {
  confirmOverwrite: (title: string, content: string) => Promise<boolean>;
  currentDirectory?: string;
  entries: SftpEntry[];
  onClearSelection: () => void;
  onLoadingChange: (loading: boolean) => void;
  onOperationError: (error: unknown) => void;
  onQueueDownload: (options: {
    archiveName: string;
    format: RemoteArchiveFormat;
    localPath: string;
    sourcePaths: string[];
  }) => void;
  onRefreshDirectory: () => void | Promise<void>;
  sessionId?: string;
}

export default function useSftpArchives({
  confirmOverwrite,
  currentDirectory,
  entries,
  onClearSelection,
  onLoadingChange,
  onOperationError,
  onQueueDownload,
  onRefreshDirectory,
  sessionId,
}: SftpArchivesOptions) {
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(
    null,
  );
  const [archiveBaseName, setArchiveBaseName] = useState("");
  const [archiveFormat, setArchiveFormat] =
    useState<RemoteArchiveFormat>("tarGz");

  function openArchiveDialog(
    targetEntries: SftpEntry[],
    mode: ArchiveDialogState["mode"],
  ) {
    const suggestedBase =
      targetEntries.length === 1
        ? remoteArchiveBaseName(targetEntries[0].name)
        : "archive";
    const suggestedName = nextAvailableRemoteArchiveName(
      suggestedBase || "archive",
      "tarGz",
      new Set(entries.map((entry) => entry.name)),
    );
    setArchiveFormat("tarGz");
    setArchiveBaseName(remoteArchiveBaseName(suggestedName));
    setArchiveDialog({ entries: targetEntries, mode });
  }

  function closeArchiveDialog() {
    setArchiveDialog(null);
    setArchiveBaseName("");
    setArchiveFormat("tarGz");
  }

  async function submitArchiveDialog() {
    if (!archiveDialog || !sessionId || !currentDirectory) return;
    const archiveName = remoteArchiveFileName(
      archiveBaseName.trim(),
      archiveFormat,
    );
    if (!isValidRemoteName(archiveName)) {
      Message.warning("请输入有效的归档文件名称");
      return;
    }
    const sourcePaths = archiveDialog.entries.map((entry) => entry.path);

    if (archiveDialog.mode === "download") {
      const target = await save({
        defaultPath: archiveName,
        title: `打包下载 ${archiveDialog.entries.length} 个项目`,
      });
      if (!target) return;
      onQueueDownload({
        archiveName,
        format: archiveFormat,
        localPath: target,
        sourcePaths,
      });
      closeArchiveDialog();
      onClearSelection();
      Message.info("已加入打包下载任务");
      return;
    }

    const targetPath = remoteJoinPath(currentDirectory, archiveName);
    const overwrite = entries.some((entry) => entry.path === targetPath);
    if (
      overwrite &&
      !(await confirmOverwrite(
        "覆盖已有归档？",
        `当前目录已经存在“${archiveName}”，继续后将覆盖该文件。`,
      ))
    ) {
      return;
    }

    onLoadingChange(true);
    try {
      await invoke("sftp_create_archive", {
        sessionId,
        sourcePaths,
        targetPath,
        format: archiveFormat,
        overwrite,
      });
      closeArchiveDialog();
      onClearSelection();
      Message.success(`已创建 ${archiveName}`);
      await onRefreshDirectory();
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  async function extractRemoteArchive(
    entry: SftpEntry,
    createDirectory: boolean,
  ) {
    if (!sessionId || !currentDirectory) return;
    const format = remoteArchiveFormatFromName(entry.name);
    if (!format) {
      Message.warning("当前文件不是支持的归档格式");
      return;
    }
    const targetName = remoteArchiveBaseName(entry.name);
    const targetDirectory = createDirectory
      ? remoteJoinPath(currentDirectory, targetName)
      : currentDirectory;
    if (
      createDirectory &&
      entries.some((candidate) => candidate.path === targetDirectory)
    ) {
      Message.warning(`目标目录“${targetName}”已存在`);
      return;
    }
    if (
      !createDirectory &&
      !(await confirmOverwrite(
        "解压到当前目录？",
        "归档中的同名文件将被覆盖，该操作无法自动撤销。",
      ))
    ) {
      return;
    }

    onLoadingChange(true);
    try {
      await invoke("sftp_extract_archive", {
        sessionId,
        archivePath: entry.path,
        targetDirectory,
        format,
        createDirectory,
      });
      Message.success(
        createDirectory
          ? `已解压到 ${targetName}`
          : `已将 ${entry.name} 解压到当前目录`,
      );
      await onRefreshDirectory();
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  return {
    archiveBaseName,
    archiveDialog,
    archiveFormat,
    closeArchiveDialog,
    extractRemoteArchive,
    openArchiveDialog,
    setArchiveBaseName,
    setArchiveFormat,
    submitArchiveDialog,
  };
}
