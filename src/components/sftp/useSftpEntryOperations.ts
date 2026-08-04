import { useMemo, useState } from "react";
import { Message, Modal } from "@arco-design/web-react";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpEntry } from "../../models";
import {
  formatPermissions,
  isValidRemoteName,
  parsePermissions,
  remoteJoinPath,
} from "../../sftp-utils";
import type { CreateEntryKind } from "./SftpDialogs";

interface SftpEntryOperationsOptions {
  confirmFileDelete: boolean;
  currentDirectory?: string;
  entries: SftpEntry[];
  onClearSelection: () => void;
  onLoadingChange: (loading: boolean) => void;
  onOperationError: (error: unknown) => void;
  onRefreshDirectory: () => void | Promise<void>;
  sessionId?: string;
}

export default function useSftpEntryOperations({
  confirmFileDelete,
  currentDirectory,
  entries,
  onClearSelection,
  onLoadingChange,
  onOperationError,
  onRefreshDirectory,
  sessionId,
}: SftpEntryOperationsOptions) {
  const [creatingEntryKind, setCreatingEntryKind] =
    useState<CreateEntryKind | null>(null);
  const [newEntryName, setNewEntryName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [permissionEntries, setPermissionEntries] = useState<SftpEntry[]>([]);
  const [permissionValue, setPermissionValue] = useState("");
  const [permissionOwner, setPermissionOwner] = useState("");
  const [permissionGroup, setPermissionGroup] = useState("");
  const parsedPermissionValue = useMemo(
    () => parsePermissions(permissionValue),
    [permissionValue],
  );

  function openCreateDialog(kind: CreateEntryKind) {
    setCreatingEntryKind(kind);
    setNewEntryName("");
  }

  async function createEntry() {
    if (!sessionId || !currentDirectory || !creatingEntryKind) return;
    const name = newEntryName.trim();
    if (!isValidRemoteName(name)) {
      Message.warning("名称不能为空，且不能包含路径分隔符");
      return;
    }

    onLoadingChange(true);
    try {
      await invoke(
        creatingEntryKind === "directory"
          ? "sftp_create_directory"
          : "sftp_create_file",
        {
          sessionId,
          path: remoteJoinPath(currentDirectory, name),
        },
      );
      Message.success(
        `已新建${creatingEntryKind === "directory" ? "目录" : "文件"} ${name}`,
      );
      setCreatingEntryKind(null);
      setNewEntryName("");
      await onRefreshDirectory();
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  function openRenameDialog(entry: SftpEntry) {
    setRenamingEntry(entry);
    setRenameName(entry.name);
  }

  async function renameEntry(overwrite = false) {
    if (!sessionId || !currentDirectory || !renamingEntry) return;
    const name = renameName.trim();
    if (!isValidRemoteName(name)) {
      Message.warning("名称不能为空，且不能包含路径分隔符");
      return;
    }
    if (name === renamingEntry.name) {
      setRenamingEntry(null);
      return;
    }

    const targetPath = remoteJoinPath(currentDirectory, name);
    const targetExists = entries.some(
      (entry) => entry.id !== renamingEntry.id && entry.name === name,
    );
    if (targetExists && !overwrite) {
      Modal.confirm({
        cancelText: "取消",
        content: `“${name}”已存在，继续将尝试覆盖目标。`,
        okText: "覆盖",
        onOk: () => renameEntry(true),
        title: "覆盖远程项目？",
      });
      return;
    }

    onLoadingChange(true);
    try {
      await invoke("sftp_rename", {
        sessionId,
        sourcePath: renamingEntry.path,
        targetPath,
        overwrite,
      });
      setRenamingEntry(null);
      setRenameName("");
      Message.success(`已重命名为 ${name}`);
      await onRefreshDirectory();
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  async function deleteEntries(targetEntries: SftpEntry[]) {
    if (!sessionId || targetEntries.length === 0) return;
    let deletedCount = 0;
    try {
      for (const entry of targetEntries) {
        await invoke("sftp_delete", {
          sessionId,
          path: entry.path,
        });
        deletedCount += 1;
      }
      onClearSelection();
      Message.success(
        targetEntries.length === 1
          ? `已删除 ${targetEntries[0].name}`
          : `已删除 ${targetEntries.length} 个项目`,
      );
    } catch (error) {
      onOperationError(error);
      throw error;
    } finally {
      if (deletedCount > 0) {
        await onRefreshDirectory();
      }
    }
  }

  function requestDeleteEntries(targetEntries: SftpEntry[]) {
    const execute = () => deleteEntries(targetEntries).catch(() => undefined);
    if (!confirmFileDelete) {
      void execute();
      return;
    }

    const containsDirectory = targetEntries.some(
      (entry) => entry.kind === "directory",
    );
    Modal.confirm({
      cancelText: "取消",
      content:
        targetEntries.length === 1
          ? `删除“${targetEntries[0].name}”？${containsDirectory ? "目录必须为空。" : ""}`
          : `删除选中的 ${targetEntries.length} 个项目？${containsDirectory ? "目录必须为空。" : ""}`,
      okButtonProps: { status: "danger" },
      okText: "删除",
      onOk: execute,
      title: "确认删除",
    });
  }

  async function fastDeleteEntries(targetEntries: SftpEntry[]) {
    if (!sessionId || targetEntries.length === 0) return;
    onLoadingChange(true);
    try {
      await invoke("sftp_fast_delete", {
        sessionId,
        paths: targetEntries.map((entry) => entry.path),
      });
      onClearSelection();
      Message.success(
        targetEntries.length === 1
          ? `已快速删除 ${targetEntries[0].name}`
          : `已快速删除 ${targetEntries.length} 个项目`,
      );
      await onRefreshDirectory();
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  function requestFastDelete(targetEntries: SftpEntry[]) {
    Modal.confirm({
      cancelText: "取消",
      content:
        targetEntries.length === 1
          ? `将通过 rm -rf 永久删除“${targetEntries[0].name}”，目录中的内容也会被删除。`
          : `将通过 rm -rf 永久删除选中的 ${targetEntries.length} 个项目，目录中的内容也会被删除。`,
      okButtonProps: { status: "danger" },
      okText: "快速删除",
      onOk: () => fastDeleteEntries(targetEntries),
      title: "确认快速删除",
    });
  }

  function openPermissionsDialog(targetEntries: SftpEntry[]) {
    const firstPermissions = targetEntries[0]?.permissions;
    const samePermissions = targetEntries.every(
      (entry) => entry.permissions === firstPermissions,
    );
    setPermissionEntries(targetEntries);
    setPermissionValue(
      samePermissions && firstPermissions !== undefined
        ? formatPermissions(firstPermissions)
        : "",
    );
    setPermissionOwner(
      targetEntries.every((entry) => entry.owner === targetEntries[0]?.owner)
        ? (targetEntries[0]?.owner ?? "")
        : "",
    );
    setPermissionGroup(
      targetEntries.every((entry) => entry.group === targetEntries[0]?.group)
        ? (targetEntries[0]?.group ?? "")
        : "",
    );
  }

  async function updatePermissions() {
    if (!sessionId || permissionEntries.length === 0) return;
    const permissions = permissionValue.trim()
      ? parsePermissions(permissionValue)
      : null;
    if (permissionValue.trim() && permissions === null) {
      Message.warning("请输入 3 到 4 位八进制权限");
      return;
    }
    const owner = permissionOwner.trim();
    const group = permissionGroup.trim();
    const hasChanges = permissionEntries.some(
      (entry) =>
        (permissions !== null && entry.permissions !== permissions) ||
        (owner && entry.owner !== owner) ||
        (group && entry.group !== group),
    );
    if (!hasChanges) {
      Message.info("没有需要保存的更改");
      return;
    }

    onLoadingChange(true);
    let didUpdate = false;
    try {
      for (const entry of permissionEntries) {
        if (permissions !== null && entry.permissions !== permissions) {
          await invoke("sftp_set_permissions", {
            sessionId,
            path: entry.path,
            permissions,
          });
          didUpdate = true;
        }
        const nextOwner = owner && entry.owner !== owner ? owner : null;
        const nextGroup = group && entry.group !== group ? group : null;
        if (nextOwner || nextGroup) {
          await invoke("sftp_set_owner", {
            sessionId,
            path: entry.path,
            owner: nextOwner,
            group: nextGroup,
          });
          didUpdate = true;
        }
      }
      Message.success(
        permissionEntries.length === 1
          ? `已保存 ${permissionEntries[0].name} 的属性`
          : `已保存 ${permissionEntries.length} 个项目的属性`,
      );
      setPermissionEntries([]);
      setPermissionValue("");
      setPermissionOwner("");
      setPermissionGroup("");
    } catch (error) {
      onOperationError(error);
    } finally {
      if (didUpdate) {
        await onRefreshDirectory();
      }
      onLoadingChange(false);
    }
  }

  function closeCreateDialog() {
    setCreatingEntryKind(null);
    setNewEntryName("");
  }

  function closePermissionsDialog() {
    setPermissionEntries([]);
    setPermissionValue("");
    setPermissionOwner("");
    setPermissionGroup("");
  }

  function closeRenameDialog() {
    setRenamingEntry(null);
    setRenameName("");
  }

  return {
    closeCreateDialog,
    closePermissionsDialog,
    closeRenameDialog,
    createEntry,
    creatingEntryKind,
    newEntryName,
    openCreateDialog,
    openPermissionsDialog,
    openRenameDialog,
    parsedPermissionValue,
    permissionEntries,
    permissionGroup,
    permissionOwner,
    permissionValue,
    renameEntry,
    renameName,
    renamingEntry,
    requestDeleteEntries,
    requestFastDelete,
    setNewEntryName,
    setPermissionGroup,
    setPermissionOwner,
    setPermissionValue,
    setRenameName,
    updatePermissions,
  };
}
