import {
  IconApps,
  IconArchive,
  IconCode,
  IconCopy,
  IconDelete,
  IconDesktop,
  IconDownload,
  IconEdit,
  IconExclamationCircle,
  IconFolder,
  IconFolderAdd,
  IconLaunch,
  IconLock,
  IconPaste,
  IconRefresh,
  IconRobot,
  IconScissor,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import type { SftpEntry } from "../../models";
import { remoteArchiveFormatFromName } from "../../sftp-utils";
import type { ExternalEditPayload } from "../../tauri-protocol";
import type { ContextMenuItem } from "../ContextMenu";
import type { ArchiveDialogState } from "./SftpDialogs";

interface SftpContextMenuOptions {
  clipboardEntryCount: number;
  entries: SftpEntry[];
  externalEditorName: string;
  externalEditorPath: string;
  operationLoading: boolean;
  onArchive: (entries: SftpEntry[], mode: ArchiveDialogState["mode"]) => void;
  onChooseExternalEditor: (entry: SftpEntry) => void | Promise<void>;
  onCopy: (entries: SftpEntry[]) => void;
  onCut: (entries: SftpEntry[]) => void;
  onDelete: (entries: SftpEntry[]) => void;
  onDownload: (entry: SftpEntry) => void | Promise<void>;
  onDownloadMany: (entries: SftpEntry[]) => void | Promise<void>;
  onEditText: (entry: SftpEntry) => void | Promise<void>;
  onExtract: (entry: SftpEntry, intoDirectory: boolean) => void | Promise<void>;
  onFastDelete: (entries: SftpEntry[]) => void;
  onOpenDirectory: (entry: SftpEntry) => void;
  onOpenExternal: (
    entry: SftpEntry,
    editorPath?: string,
  ) => void | Promise<void>;
  onPaste: (targetDirectory: string) => void | Promise<void>;
  onPermissions: (entries: SftpEntry[]) => void;
  onRefresh: () => void | Promise<void>;
  onRename: (entry: SftpEntry) => void;
  onResolveExternalEdit: (edit: ExternalEditPayload) => void;
  onSendFilesToAi: (entries: SftpEntry[]) => void | Promise<void>;
  onSendSelectionToAi: (entries: SftpEntry[]) => void | Promise<void>;
  resolveExternalEdit: (entry: SftpEntry) => ExternalEditPayload | undefined;
  rootDirectory?: string;
}

export default function buildSftpContextMenu({
  clipboardEntryCount,
  entries,
  externalEditorName,
  externalEditorPath,
  operationLoading,
  onArchive,
  onChooseExternalEditor,
  onCopy,
  onCut,
  onDelete,
  onDownload,
  onDownloadMany,
  onEditText,
  onExtract,
  onFastDelete,
  onOpenDirectory,
  onOpenExternal,
  onPaste,
  onPermissions,
  onRefresh,
  onRename,
  onResolveExternalEdit,
  onSendFilesToAi,
  onSendSelectionToAi,
  resolveExternalEdit,
  rootDirectory,
}: SftpContextMenuOptions): ContextMenuItem[] {
  const singleEntry = entries.length === 1 ? entries[0] : null;
  const aiFileEntries = entries.filter((entry) => entry.kind === "file");
  const menuItems: ContextMenuItem[] = [];

  if (singleEntry?.kind === "directory") {
    menuItems.push({
      key: "open",
      label: "打开",
      icon: <IconFolder />,
      disabled: operationLoading,
      onClick: () => onOpenDirectory(singleEntry),
    });
  } else if (singleEntry) {
    if (singleEntry.kind === "file") {
      const activeEdit = resolveExternalEdit(singleEntry);
      const openItems: ContextMenuItem[] = [
        {
          key: "open-internal",
          label: "内置编辑器",
          icon: <IconCode />,
          disabled: operationLoading,
          onClick: () => onEditText(singleEntry),
        },
        {
          key: "open-default",
          label: "系统默认应用",
          icon: <IconDesktop />,
          disabled: operationLoading,
          onClick: () => onOpenExternal(singleEntry),
        },
      ];
      if (externalEditorPath) {
        openItems.push({
          key: "open-configured",
          label: externalEditorName || "已配置编辑器",
          icon: <IconLaunch />,
          disabled: operationLoading,
          onClick: () => onOpenExternal(singleEntry, externalEditorPath),
        });
      }
      openItems.push({
        key: "open-other",
        label: "选择其他应用...",
        icon: <IconApps />,
        disabled: operationLoading,
        onClick: () => onChooseExternalEditor(singleEntry),
      });
      if (
        activeEdit?.status === "conflict" ||
        activeEdit?.status === "failed"
      ) {
        openItems.push({
          key: "resolve-external-edit",
          label: "处理同步问题",
          icon: <IconExclamationCircle />,
          dividerBefore: true,
          onClick: () => onResolveExternalEdit(activeEdit),
        });
      }
      menuItems.push({
        key: "open-file",
        label: "打开",
        icon: <IconLaunch />,
        children: openItems,
        disabled: operationLoading,
      });
    }
    menuItems.push({
      key: "download",
      label: "下载",
      icon: <IconDownload />,
      disabled: operationLoading,
      onClick: () => onDownload(singleEntry),
    });
  } else if (entries.some((entry) => entry.kind !== "directory")) {
    const fileCount = entries.filter(
      (entry) => entry.kind !== "directory",
    ).length;
    menuItems.push({
      key: "download-selected",
      label: `下载所选（${fileCount}）`,
      icon: <IconDownload />,
      disabled: operationLoading,
      onClick: () => onDownloadMany(entries),
    });
  }

  if (entries.length > 0 && aiFileEntries.length === entries.length) {
    menuItems.push({
      key: "send-files-to-ai",
      label:
        aiFileEntries.length === 1
          ? "发送文件内容给 AI"
          : `发送所选文件内容给 AI（${aiFileEntries.length}）`,
      icon: <IconRobot />,
      disabled: operationLoading,
      onClick: () => onSendFilesToAi(aiFileEntries),
    });
    menuItems.push({
      key: "send-file-list-to-ai",
      label:
        entries.length === 1
          ? "发送文件信息给 AI"
          : `发送所选文件清单给 AI（${entries.length}）`,
      icon: <IconRobot />,
      disabled: operationLoading,
      onClick: () => onSendSelectionToAi(entries),
    });
  } else if (entries.length > 0) {
    menuItems.push({
      key: "send-selection-to-ai",
      label:
        entries.length === 1
          ? "发送项目信息给 AI"
          : `发送所选项目清单给 AI（${entries.length}）`,
      icon: <IconRobot />,
      disabled: operationLoading,
      onClick: () => onSendSelectionToAi(entries),
    });
  }

  const selectedArchiveFormat =
    singleEntry?.kind === "file"
      ? remoteArchiveFormatFromName(singleEntry.name)
      : null;
  if (singleEntry && selectedArchiveFormat) {
    menuItems.push({
      key: "extract",
      label: "解压",
      icon: <IconArchive />,
      dividerBefore: true,
      disabled: operationLoading,
      children: [
        {
          key: "extract-here",
          label: "解压到当前目录",
          icon: <IconArchive />,
          onClick: () => onExtract(singleEntry, false),
        },
        {
          key: "extract-directory",
          label: "解压到同名目录",
          icon: <IconFolderAdd />,
          onClick: () => onExtract(singleEntry, true),
        },
      ],
    });
  }

  if (entries.length > 0) {
    menuItems.push({
      key: "compress",
      label:
        entries.length === 1 ? "压缩..." : `压缩所选（${entries.length}）...`,
      icon: <IconArchive />,
      dividerBefore: !selectedArchiveFormat,
      disabled: operationLoading,
      onClick: () => onArchive(entries, "compress"),
    });
  }
  if (
    entries.length > 1 ||
    entries.some((entry) => entry.kind === "directory")
  ) {
    menuItems.push({
      key: "archive-download",
      label:
        entries.length === 1
          ? "打包下载..."
          : `打包下载所选（${entries.length}）...`,
      icon: <IconDownload />,
      disabled: operationLoading,
      onClick: () => onArchive(entries, "download"),
    });
  }

  if (entries.length > 0) {
    menuItems.push(
      {
        key: "copy",
        label: entries.length === 1 ? "复制" : `复制所选（${entries.length}）`,
        icon: <IconCopy />,
        disabled: operationLoading,
        dividerBefore: true,
        onClick: () => onCopy(entries),
      },
      {
        key: "cut",
        label: entries.length === 1 ? "剪切" : `剪切所选（${entries.length}）`,
        icon: <IconScissor />,
        disabled: operationLoading,
        onClick: () => onCut(entries),
      },
    );
  }

  const pasteTarget =
    singleEntry?.kind === "directory"
      ? singleEntry.path
      : entries.length === 0
        ? rootDirectory
        : undefined;
  if (clipboardEntryCount > 0 && pasteTarget) {
    menuItems.push({
      key: "paste",
      label:
        singleEntry?.kind === "directory"
          ? `粘贴到“${singleEntry.name}”`
          : `粘贴（${clipboardEntryCount}）`,
      icon: <IconPaste />,
      disabled: operationLoading,
      onClick: () => onPaste(pasteTarget),
    });
  }

  if (singleEntry) {
    menuItems.push({
      key: "rename",
      label: "重命名",
      icon: <IconEdit />,
      disabled: operationLoading,
      onClick: () => onRename(singleEntry),
    });
  }

  menuItems.push({
    key: "refresh",
    label: "刷新",
    icon: <IconRefresh />,
    disabled: operationLoading,
    onClick: onRefresh,
  });

  if (entries.length > 0) {
    menuItems.push({
      key: "permissions",
      label:
        entries.length === 1 ? "文件权限" : `修改所选权限（${entries.length}）`,
      icon: <IconLock />,
      disabled: operationLoading,
      onClick: () => onPermissions(entries),
    });
    menuItems.push(
      {
        key: "delete",
        label: entries.length === 1 ? "删除" : `删除所选（${entries.length}）`,
        icon: <IconDelete />,
        disabled: operationLoading,
        danger: true,
        dividerBefore: true,
        onClick: () => onDelete(entries),
      },
      {
        key: "fast-delete",
        label:
          entries.length === 1
            ? "删除(rm)"
            : `删除所选(rm)（${entries.length}）`,
        icon: <IconThunderbolt />,
        disabled: operationLoading,
        danger: true,
        onClick: () => onFastDelete(entries),
      },
    );
  }

  return menuItems;
}
