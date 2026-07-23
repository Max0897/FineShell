import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Menu,
  Message,
  Modal,
  Progress,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  IconArrowUp,
  IconDelete,
  IconDown,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderAdd,
  IconHistory,
  IconLock,
  IconRefresh,
  IconThunderbolt,
  IconUpload,
} from "@arco-design/web-react/icon";
import type {
  SftpConnectResult,
  SftpEntry,
  SftpListResult,
  TerminalSession,
} from "../models";
import ContextMenu from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import {
  formatFileSize,
  formatPermissions,
  formatRemoteTime,
  isValidRemoteName,
  localFileName,
  parsePermissions,
  remoteJoinPath,
  remoteParentPath,
} from "../sftp-utils";
import { jumpHostRequest, sshCredentialId } from "../terminal-utils";

type BrowserStatus = "idle" | "connecting" | "loading" | "ready" | "failed";
type CreateEntryKind = "file" | "directory";

interface BrowserState {
  status: BrowserStatus;
  path: string;
  inputPath: string;
  entries: SftpEntry[];
  error?: string;
}

interface SftpPanelProps {
  confirmFileDelete: boolean;
  session: TerminalSession | null;
  showHiddenFiles: boolean;
}

interface SftpTransferPayload {
  sessionId: string;
  transferId: string;
  direction: "upload" | "download";
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  status: "running" | "completed" | "failed";
  error?: string;
}

interface TransferRecord extends SftpTransferPayload {
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  sampledAt: number;
  sampledBytes: number;
  bytesPerSecond: number;
}

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

function createTransferId() {
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTransferSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0
    ? `${formatFileSize(bytesPerSecond)}/s`
    : "正在计算";
}

function isSftpSessionFailure(message: string) {
  return /会话不存在|会话已停止|连接已关闭|connection|disconnect|socket/i.test(
    message,
  );
}

function SftpPanel({
  confirmFileDelete,
  session,
  showHiddenFiles,
}: SftpPanelProps) {
  const [browsers, setBrowsers] = useState<Record<string, BrowserState>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferRecord>>(
    {},
  );
  const [transferDrawerVisible, setTransferDrawerVisible] = useState(false);
  const [creatingEntryKind, setCreatingEntryKind] =
    useState<CreateEntryKind | null>(null);
  const [newEntryName, setNewEntryName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [permissionEntries, setPermissionEntries] = useState<SftpEntry[]>([]);
  const [permissionValue, setPermissionValue] = useState("");
  const [operationLoading, setOperationLoading] = useState(false);
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const connectingRef = useRef(new Set<string>());
  const connectedHomesRef = useRef(new Map<string, string>());

  const updateBrowser = useCallback(
    (sessionId: string, values: Partial<BrowserState>) => {
      setBrowsers((current) => ({
        ...current,
        [sessionId]: {
          ...(current[sessionId] ?? INITIAL_BROWSER),
          ...values,
        },
      }));
    },
    [],
  );

  const loadDirectory = useCallback(
    async (sessionId: string, path: string, initial = false) => {
      updateBrowser(sessionId, {
        status: initial ? "connecting" : "loading",
        inputPath: path,
        error: undefined,
      });
      try {
        const result = await invoke<SftpListResult>("sftp_list", {
          sessionId,
          path,
        });
        updateBrowser(sessionId, {
          status: "ready",
          path: result.path,
          inputPath: result.path,
          entries: result.entries,
          error: undefined,
        });
      } catch (error) {
        const message = String(error);
        if (initial) {
          updateBrowser(sessionId, { status: "failed", error: message });
        } else {
          setBrowsers((current) => {
            const previous = current[sessionId] ?? INITIAL_BROWSER;
            return {
              ...current,
              [sessionId]: {
                ...previous,
                status: "ready",
                inputPath: previous.path,
                error: message,
              },
            };
          });
          Message.error(message);
        }
      }
    },
    [updateBrowser],
  );

  const connectAndLoad = useCallback(
    async (currentSession: TerminalSession) => {
      if (connectingRef.current.has(currentSession.id)) return;
      connectingRef.current.add(currentSession.id);
      updateBrowser(currentSession.id, {
        status: "connecting",
        error: undefined,
      });

      try {
        if (!isTauri()) {
          throw new Error("SFTP 仅在桌面应用中可用");
        }

        let homeDir = connectedHomesRef.current.get(currentSession.id);
        if (!homeDir) {
          const result = await invoke<SftpConnectResult>("sftp_connect", {
            request: {
              sessionId: currentSession.id,
              hostId: sshCredentialId(currentSession.host),
              address: currentSession.host.address,
              port: currentSession.host.port,
              username: currentSession.host.username,
              authMethod: currentSession.host.authMethod,
              privateKeyPath: currentSession.host.privateKeyPath,
              connectTimeoutSeconds:
                currentSession.host.connectTimeoutSeconds,
              keepAliveIntervalSeconds:
                currentSession.host.keepAliveIntervalSeconds,
              expectedFingerprint:
                currentSession.fingerprint ??
                currentSession.host.hostFingerprint,
              proxy: currentSession.proxy,
              jumpHost: jumpHostRequest(currentSession.jumpHost),
            },
          });
          homeDir = result.homeDir;
          connectedHomesRef.current.set(currentSession.id, homeDir);
        }
        await loadDirectory(currentSession.id, homeDir, true);
      } catch (error) {
        updateBrowser(currentSession.id, {
          status: "failed",
          error: String(error),
        });
      } finally {
        connectingRef.current.delete(currentSession.id);
      }
    },
    [loadDirectory, updateBrowser],
  );

  useEffect(() => {
    if (!session) return;

    if (session.status === "connected") {
      const browser = browsers[session.id];
      if (!browser || browser.status === "idle") {
        void connectAndLoad(session);
      }
      return;
    }

    if (
      connectedHomesRef.current.has(session.id) ||
      connectingRef.current.has(session.id)
    ) {
      connectedHomesRef.current.delete(session.id);
      connectingRef.current.delete(session.id);
      void invoke("sftp_disconnect", { sessionId: session.id }).catch(
        () => undefined,
      );
      updateBrowser(session.id, {
        status: "idle",
        entries: [],
        error: undefined,
      });
    }
  }, [browsers, connectAndLoad, session, updateBrowser]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SftpTransferPayload>("sftp-transfer", ({ payload }) => {
      setTransfers((current) => {
        const previous = current[payload.transferId];
        if (!previous) return current;
        const now = Date.now();
        const transferredBytes =
          payload.status === "failed" && payload.transferredBytes === 0
            ? previous.transferredBytes
            : payload.transferredBytes;
        const elapsedSeconds = (now - previous.sampledAt) / 1000;
        const shouldSample =
          transferredBytes >= previous.sampledBytes &&
          (elapsedSeconds >= 0.25 || payload.status !== "running");
        const currentSpeed = shouldSample
          ? (transferredBytes - previous.sampledBytes) /
            Math.max(elapsedSeconds, 0.001)
          : previous.bytesPerSecond;
        const bytesPerSecond = shouldSample
          ? previous.bytesPerSecond > 0
            ? previous.bytesPerSecond * 0.6 + currentSpeed * 0.4
            : currentSpeed
          : previous.bytesPerSecond;
        return {
          ...current,
          [payload.transferId]: {
            ...previous,
            ...payload,
            transferredBytes,
            totalBytes: payload.totalBytes || previous.totalBytes,
            sampledAt: shouldSample ? now : previous.sampledAt,
            sampledBytes: shouldSample
              ? transferredBytes
              : previous.sampledBytes,
            bytesPerSecond,
          },
        };
      });
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const browser = session ? browsers[session.id] ?? INITIAL_BROWSER : null;
  const connected = session?.status === "connected";
  const ready = Boolean(connected && browser?.status === "ready");
  const busy =
    browser?.status === "connecting" || browser?.status === "loading";
  const currentTransfers = useMemo(
    () =>
      Object.values(transfers)
        .filter((transfer) => transfer.sessionId === session?.id)
        .reverse(),
    [session?.id, transfers],
  );
  const visibleEntries = useMemo(
    () =>
      (browser?.entries ?? []).filter(
        (entry) => showHiddenFiles || !entry.name.startsWith("."),
      ),
    [browser?.entries, showHiddenFiles],
  );

  useEffect(() => {
    setSelectedEntryKeys([]);
  }, [browser?.path, session?.id]);

  useEffect(() => {
    const visibleKeys = new Set(visibleEntries.map((entry) => entry.id));
    setSelectedEntryKeys((current) => {
      const next = current.filter((key) => visibleKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [visibleEntries]);

  const columns = useMemo<TableColumnProps<SftpEntry>[]>(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        render: (_, entry) => (
          <div className="sftp-name-cell">
            {entry.kind === "directory" ? <IconFolder /> : <IconFile />}
            <Typography.Text ellipsis>{entry.name}</Typography.Text>
          </div>
        ),
      },
      {
        title: "大小",
        dataIndex: "size",
        width: 110,
        render: (_, entry) =>
          entry.kind === "directory" ? "-" : formatFileSize(entry.size),
      },
      {
        title: "权限",
        dataIndex: "permissions",
        width: 86,
        render: (value) => formatPermissions(value),
      },
      {
        title: "修改时间",
        dataIndex: "modifiedAt",
        width: 150,
        render: (value) => formatRemoteTime(value),
      },
    ],
    [],
  );

  async function runTransfer(
    direction: "upload" | "download",
    localPath: string,
    remotePath: string,
    overwrite: boolean,
    transferId = createTransferId(),
  ) {
    if (!session) return;
    const fileName =
      direction === "upload"
        ? localFileName(localPath)
        : remotePath.split("/").pop() || remotePath;
    const record: TransferRecord = {
      sessionId: session.id,
      transferId,
      direction,
      fileName,
      transferredBytes: 0,
      totalBytes: 0,
      status: "running",
      localPath,
      remotePath,
      overwrite,
      sampledAt: Date.now(),
      sampledBytes: 0,
      bytesPerSecond: 0,
    };
    setTransfers((current) => ({ ...current, [transferId]: record }));

    try {
      await invoke(direction === "upload" ? "sftp_upload" : "sftp_download", {
        sessionId: session.id,
        transferId,
        localPath,
        remotePath,
        overwrite,
      });
      Message.success(`${direction === "upload" ? "上传" : "下载"}完成：${fileName}`);
      if (direction === "upload" && browser) {
        await loadDirectory(session.id, browser.path);
      }
    } catch (error) {
      const message = String(error);
      if (isSftpSessionFailure(message)) {
        connectedHomesRef.current.delete(session.id);
        updateBrowser(session.id, { status: "failed", error: message });
      }
      setTransfers((current) => {
        const previous = current[transferId] ?? record;
        return {
          ...current,
          [transferId]: {
            ...previous,
            status: "failed",
            error: message,
          },
        };
      });
      Message.error(message);
    }
  }

  async function chooseUploadFile() {
    if (!session || !browser || !ready) return;
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择上传文件",
    });
    if (typeof selected !== "string") return;

    const fileName = localFileName(selected);
    const remotePath = remoteJoinPath(browser.path, fileName);
    const existing = browser.entries.find((entry) => entry.name === fileName);
    if (existing) {
      Modal.confirm({
        title: "覆盖远程文件？",
        content: `“${fileName}”已存在，继续上传将覆盖它。`,
        okText: "覆盖",
        cancelText: "取消",
        onOk: () => runTransfer("upload", selected, remotePath, true),
      });
      return;
    }

    await runTransfer("upload", selected, remotePath, false);
  }

  async function downloadEntry(entry: SftpEntry) {
    if (!session || !ready) return;
    const target = await save({
      defaultPath: entry.name,
      title: `下载 ${entry.name}`,
    });
    if (!target) return;
    await runTransfer("download", target, entry.path, true);
  }

  async function retryTransfer(transfer: TransferRecord) {
    await runTransfer(
      transfer.direction,
      transfer.localPath,
      transfer.remotePath,
      transfer.overwrite,
      transfer.transferId,
    );
  }

  function clearFinishedTransfers() {
    if (!session) return;
    setTransfers((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([, transfer]) =>
            transfer.sessionId !== session.id || transfer.status === "running",
        ),
      ),
    );
  }

  function handleOperationError(error: unknown) {
    const message = String(error);
    if (session && isSftpSessionFailure(message)) {
      connectedHomesRef.current.delete(session.id);
      updateBrowser(session.id, { status: "failed", error: message });
    }
    Message.error(message);
  }

  function openCreateDialog(kind: CreateEntryKind) {
    setCreatingEntryKind(kind);
    setNewEntryName("");
  }

  async function createEntry() {
    if (!session || !browser || !creatingEntryKind) return;
    const name = newEntryName.trim();
    if (!isValidRemoteName(name)) {
      Message.warning("名称不能为空，且不能包含路径分隔符");
      return;
    }

    setOperationLoading(true);
    try {
      await invoke(
        creatingEntryKind === "directory"
          ? "sftp_create_directory"
          : "sftp_create_file",
        {
          sessionId: session.id,
          path: remoteJoinPath(browser.path, name),
        },
      );
      Message.success(
        `已新建${creatingEntryKind === "directory" ? "目录" : "文件"} ${name}`,
      );
      setCreatingEntryKind(null);
      setNewEntryName("");
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  function openRenameDialog(entry: SftpEntry) {
    setRenamingEntry(entry);
    setRenameName(entry.name);
  }

  async function renameEntry(overwrite = false) {
    if (!session || !browser || !renamingEntry) return;
    const name = renameName.trim();
    if (!isValidRemoteName(name)) {
      Message.warning("名称不能为空，且不能包含路径分隔符");
      return;
    }
    if (name === renamingEntry.name) {
      setRenamingEntry(null);
      return;
    }

    const targetPath = remoteJoinPath(browser.path, name);
    const targetExists = browser.entries.some(
      (entry) => entry.id !== renamingEntry.id && entry.name === name,
    );
    if (targetExists && !overwrite) {
      Modal.confirm({
        title: "覆盖远程项目？",
        content: `“${name}”已存在，继续将尝试覆盖目标。`,
        okText: "覆盖",
        cancelText: "取消",
        onOk: () => renameEntry(true),
      });
      return;
    }

    setOperationLoading(true);
    try {
      await invoke("sftp_rename", {
        sessionId: session.id,
        sourcePath: renamingEntry.path,
        targetPath,
        overwrite,
      });
      setRenamingEntry(null);
      setRenameName("");
      Message.success(`已重命名为 ${name}`);
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  async function deleteEntries(entries: SftpEntry[]) {
    if (!session || !browser || entries.length === 0) return;
    let deletedCount = 0;
    try {
      for (const entry of entries) {
        await invoke("sftp_delete", {
          sessionId: session.id,
          path: entry.path,
        });
        deletedCount += 1;
      }
      setSelectedEntryKeys([]);
      Message.success(
        entries.length === 1
          ? `已删除 ${entries[0].name}`
          : `已删除 ${entries.length} 个项目`,
      );
    } catch (error) {
      handleOperationError(error);
      throw error;
    } finally {
      if (deletedCount > 0) {
        await loadDirectory(session.id, browser.path);
      }
    }
  }

  function requestDeleteEntries(entries: SftpEntry[]) {
    const execute = () => deleteEntries(entries).catch(() => undefined);
    if (!confirmFileDelete) {
      void execute();
      return;
    }

    const containsDirectory = entries.some(
      (entry) => entry.kind === "directory",
    );
    Modal.confirm({
      cancelText: "取消",
      content:
        entries.length === 1
          ? `删除“${entries[0].name}”？${containsDirectory ? "目录必须为空。" : ""}`
          : `删除选中的 ${entries.length} 个项目？${containsDirectory ? "目录必须为空。" : ""}`,
      okButtonProps: { status: "danger" },
      okText: "删除",
      onOk: execute,
      title: "确认删除",
    });
  }

  async function fastDeleteEntries(entries: SftpEntry[]) {
    if (!session || !browser || entries.length === 0) return;
    setOperationLoading(true);
    try {
      await invoke("sftp_fast_delete", {
        sessionId: session.id,
        paths: entries.map((entry) => entry.path),
      });
      setSelectedEntryKeys([]);
      Message.success(
        entries.length === 1
          ? `已快速删除 ${entries[0].name}`
          : `已快速删除 ${entries.length} 个项目`,
      );
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  function requestFastDelete(entries: SftpEntry[]) {
    Modal.confirm({
      cancelText: "取消",
      content:
        entries.length === 1
          ? `将通过 rm -rf 永久删除“${entries[0].name}”，目录中的内容也会被删除。`
          : `将通过 rm -rf 永久删除选中的 ${entries.length} 个项目，目录中的内容也会被删除。`,
      okButtonProps: { status: "danger" },
      okText: "快速删除",
      onOk: () => fastDeleteEntries(entries),
      title: "确认快速删除",
    });
  }

  function openPermissionsDialog(entries: SftpEntry[]) {
    const firstPermissions = entries[0]?.permissions;
    const samePermissions = entries.every(
      (entry) => entry.permissions === firstPermissions,
    );
    setPermissionEntries(entries);
    setPermissionValue(
      samePermissions && firstPermissions !== undefined
        ? formatPermissions(firstPermissions)
        : "",
    );
  }

  async function updatePermissions() {
    if (!session || !browser || permissionEntries.length === 0) return;
    const permissions = parsePermissions(permissionValue);
    if (permissions === null) {
      Message.warning("请输入 3 到 4 位八进制权限");
      return;
    }

    setOperationLoading(true);
    let updatedCount = 0;
    try {
      for (const entry of permissionEntries) {
        await invoke("sftp_set_permissions", {
          sessionId: session.id,
          path: entry.path,
          permissions,
        });
        updatedCount += 1;
      }
      Message.success(
        permissionEntries.length === 1
          ? `已修改 ${permissionEntries[0].name} 的权限`
          : `已修改 ${permissionEntries.length} 个项目的权限`,
      );
      setPermissionEntries([]);
      setPermissionValue("");
    } catch (error) {
      handleOperationError(error);
    } finally {
      if (updatedCount > 0) {
        await loadDirectory(session.id, browser.path);
      }
      setOperationLoading(false);
    }
  }

  function entryContextMenuItems(entries: SftpEntry[]): ContextMenuItem[] {
    const singleEntry = entries.length === 1 ? entries[0] : null;
    const menuItems: ContextMenuItem[] = [];

    if (singleEntry?.kind === "directory") {
      menuItems.push({
        key: "open",
        label: "打开",
        icon: <IconFolder />,
        disabled: operationLoading,
        onClick: () => openDirectory(singleEntry),
      });
    } else if (singleEntry) {
      menuItems.push({
        key: "download",
        label: "下载",
        icon: <IconDownload />,
        disabled: operationLoading,
        onClick: () => downloadEntry(singleEntry),
      });
    }

    if (singleEntry) {
      menuItems.push({
        key: "rename",
        label: "重命名",
        icon: <IconEdit />,
        disabled: operationLoading,
        onClick: () => openRenameDialog(singleEntry),
      });
    }

    menuItems.push({
      key: "refresh",
      label: "刷新",
      icon: <IconRefresh />,
      disabled: operationLoading,
      onClick: () => {
        if (session && browser) {
          return loadDirectory(session.id, browser.path);
        }
      },
    });

    if (entries.length > 0) {
      menuItems.push({
        key: "permissions",
        label:
          entries.length === 1
            ? "文件权限"
            : `修改所选权限（${entries.length}）`,
        icon: <IconLock />,
        disabled: operationLoading,
        onClick: () => openPermissionsDialog(entries),
      });
    }

    if (entries.length > 0) {
      menuItems.push(
        {
          key: "delete",
          label:
            entries.length === 1 ? "删除" : `删除所选（${entries.length}）`,
          icon: <IconDelete />,
          disabled: operationLoading,
          danger: true,
          dividerBefore: true,
          onClick: () => requestDeleteEntries(entries),
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
          onClick: () => requestFastDelete(entries),
        },
      );
    }

    return menuItems;
  }

  function resolveEntryContextMenu(
    event: React.MouseEvent<HTMLElement>,
  ): ContextMenuItem[] {
    if (!ready || !(event.target instanceof Element)) return [];
    const row = event.target.closest<HTMLElement>("[data-sftp-entry-id]");
    const entry = visibleEntries.find(
      (candidate) => candidate.id === row?.dataset.sftpEntryId,
    );
    if (!entry) {
      setSelectedEntryKeys([]);
      return entryContextMenuItems([]);
    }

    const entries = selectedEntryKeys.includes(entry.id)
      ? visibleEntries.filter((candidate) =>
          selectedEntryKeys.includes(candidate.id),
        )
      : [entry];
    if (!selectedEntryKeys.includes(entry.id)) {
      setSelectedEntryKeys([entry.id]);
    }
    return entryContextMenuItems(entries);
  }

  async function retryConnection() {
    if (!session) return;
    connectedHomesRef.current.delete(session.id);
    await invoke("sftp_disconnect", { sessionId: session.id }).catch(
      () => undefined,
    );
    updateBrowser(session.id, { status: "idle", error: undefined });
    await connectAndLoad(session);
  }

  function openDirectory(entry: SftpEntry) {
    if (!session || entry.kind !== "directory") return;
    void loadDirectory(session.id, entry.path);
  }

  return (
    <section className="panel sftp-panel">
      <div className="panel-toolbar sftp-toolbar">
        <Space size="mini">
          <Tooltip content="返回上级目录">
            <Button
              aria-label="返回上级目录"
              disabled={!ready || browser?.path === "/"}
              icon={<IconArrowUp />}
              onClick={() =>
                session &&
                browser &&
                void loadDirectory(
                  session.id,
                  remoteParentPath(browser.path),
                )
              }
              size="mini"
            />
          </Tooltip>
          <Tooltip content="刷新">
            <Button
              aria-label="刷新目录"
              disabled={!ready}
              icon={<IconRefresh />}
              loading={browser?.status === "loading"}
              onClick={() =>
                session &&
                browser &&
                void loadDirectory(session.id, browser.path)
              }
              size="mini"
            />
          </Tooltip>
        </Space>
        <Input
          className="sftp-path"
          disabled={!ready}
          onChange={(value) =>
            session && updateBrowser(session.id, { inputPath: value })
          }
          onPressEnter={() =>
            session &&
            browser?.inputPath.trim() &&
            void loadDirectory(session.id, browser.inputPath.trim())
          }
          size="small"
          value={connected ? browser?.inputPath ?? "/" : ""}
        />
        <Space size="mini">
          <Dropdown.Button
            buttonProps={{ icon: <IconFolderAdd /> }}
            disabled={!ready}
            droplist={
              <Menu
                className="sftp-create-menu"
                onClickMenuItem={(key) =>
                  openCreateDialog(key === "file" ? "file" : "directory")
                }
                selectable={false}
              >
                <Menu.Item key="file">
                  <span className="sftp-create-menu-label">
                    <IconFile />
                    新建文件
                  </span>
                </Menu.Item>
                <Menu.Item key="directory">
                  <span className="sftp-create-menu-label">
                    <IconFolderAdd />
                    新建目录
                  </span>
                </Menu.Item>
              </Menu>
            }
            icon={<IconDown />}
            onClick={() => openCreateDialog("directory")}
            size="mini"
            trigger="click"
          >
            新建
          </Dropdown.Button>
          <Button
            disabled={!ready}
            icon={<IconUpload />}
            onClick={() => void chooseUploadFile()}
            size="mini"
            type="primary"
          >
            上传
          </Button>
          <Tooltip content="传输记录">
            <Badge count={currentTransfers.length} maxCount={99}>
              <Button
                aria-label="打开传输记录"
                icon={<IconHistory />}
                onClick={() => setTransferDrawerVisible(true)}
                size="mini"
              />
            </Badge>
          </Tooltip>
        </Space>
      </div>
      {connected && browser?.status === "failed" ? (
        <div className="panel-empty">
          <div className="empty-action">
            <Empty description={browser.error || "SFTP 连接失败"} />
            <Button icon={<IconRefresh />} onClick={() => void retryConnection()}>
              重试
            </Button>
          </div>
        </div>
      ) : (
        <ContextMenu
          menuClassName="sftp-context-menu"
          resolveItems={resolveEntryContextMenu}
        >
          <div className="sftp-table-container">
            <Table
              border={false}
              className="sftp-table"
              columns={columns}
              data={ready ? visibleEntries : []}
              loading={Boolean(connected && busy)}
              noDataElement={
                <Empty description={ready ? "目录为空" : "暂无文件"} />
              }
              onRow={(entry) => ({
                "data-sftp-entry-id": entry.id,
                onDoubleClick: () => openDirectory(entry),
              })}
              pagination={false}
              rowKey="id"
              rowSelection={{
                checkAll: true,
                columnWidth: 42,
                onChange: (keys) =>
                  setSelectedEntryKeys(keys.map((key) => String(key))),
                selectedRowKeys: selectedEntryKeys,
                type: "checkbox",
              }}
              size="small"
            />
          </div>
        </ContextMenu>
      )}
      <Drawer
        bodyStyle={{ padding: 0 }}
        className="sftp-transfer-drawer"
        footer={null}
        onCancel={() => setTransferDrawerVisible(false)}
        title="传输记录"
        visible={transferDrawerVisible}
        width={440}
      >
        {currentTransfers.length > 0 && (
          <div className="sftp-transfer-drawer-toolbar">
            <Typography.Text type="secondary">
              共 {currentTransfers.length} 条
            </Typography.Text>
            {currentTransfers.some((item) => item.status !== "running") && (
              <Tooltip content="清除已结束任务">
                <Button
                  aria-label="清除已结束传输任务"
                  icon={<IconDelete />}
                  onClick={clearFinishedTransfers}
                  size="mini"
                  type="text"
                />
              </Tooltip>
            )}
          </div>
        )}
        {currentTransfers.length === 0 ? (
          <div className="sftp-transfer-empty">
            <Empty description="暂无传输记录" />
          </div>
        ) : (
          <div className="sftp-transfer-list">
            {currentTransfers.map((transfer) => {
              const percent = transfer.totalBytes
                ? Math.min(
                    100,
                    Math.round(
                      (transfer.transferredBytes / transfer.totalBytes) * 100,
                    ),
                  )
                : transfer.status === "completed"
                  ? 100
                  : 0;
              const sizeText = transfer.totalBytes
                ? `${formatFileSize(transfer.transferredBytes)} / ${formatFileSize(transfer.totalBytes)}`
                : transfer.transferredBytes > 0
                  ? formatFileSize(transfer.transferredBytes)
                  : "等待传输";
              const activityText =
                transfer.status === "completed"
                  ? "已完成"
                  : transfer.status === "failed"
                    ? "传输失败"
                    : formatTransferSpeed(transfer.bytesPerSecond);

              return (
                <div className="sftp-transfer-row" key={transfer.transferId}>
                  <span
                    className={`sftp-transfer-direction sftp-transfer-direction-${transfer.direction}`}
                  >
                    {transfer.direction === "upload" ? (
                      <IconUpload />
                    ) : (
                      <IconDownload />
                    )}
                  </span>
                  <div className="sftp-transfer-content">
                    <div className="sftp-transfer-title-row">
                      <Typography.Text
                        className="sftp-transfer-file-name"
                        ellipsis={{ showTooltip: true }}
                      >
                        {transfer.fileName}
                      </Typography.Text>
                    </div>
                    <div className="sftp-transfer-meta">
                      <Typography.Text type="secondary">
                        {sizeText}
                      </Typography.Text>
                      <Typography.Text
                        className={`sftp-transfer-activity sftp-transfer-activity-${transfer.status}`}
                        type={transfer.status === "failed" ? "error" : "secondary"}
                      >
                        {activityText}
                      </Typography.Text>
                    </div>
                    <Progress
                      percent={percent}
                      showText={false}
                      size="small"
                      status={
                        transfer.status === "failed" ? "error" : "normal"
                      }
                      strokeWidth={3}
                    />
                    {transfer.status === "failed" && transfer.error && (
                      <Typography.Text
                        className="sftp-transfer-error"
                        ellipsis={{ showTooltip: true }}
                        type="error"
                      >
                        {transfer.error}
                      </Typography.Text>
                    )}
                  </div>
                  {transfer.status === "failed" && (
                    <Tooltip content="重试">
                      <Button
                        aria-label={`重试 ${transfer.fileName}`}
                        className="sftp-transfer-retry"
                        icon={<IconRefresh />}
                        onClick={() => void retryTransfer(transfer)}
                        size="mini"
                      />
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Drawer>
      <Modal
        confirmLoading={operationLoading}
        maskClosable={false}
        onCancel={() => {
          setCreatingEntryKind(null);
          setNewEntryName("");
        }}
        onOk={() => void createEntry()}
        title={creatingEntryKind === "directory" ? "新建文件夹" : "新建文件"}
        visible={Boolean(creatingEntryKind)}
      >
        <Input
          autoFocus
          onChange={setNewEntryName}
          onPressEnter={() => void createEntry()}
          placeholder={
            creatingEntryKind === "directory" ? "文件夹名称" : "文件名称"
          }
          value={newEntryName}
        />
      </Modal>
      <Modal
        confirmLoading={operationLoading}
        maskClosable={false}
        onCancel={() => {
          setPermissionEntries([]);
          setPermissionValue("");
        }}
        onOk={() => void updatePermissions()}
        title={
          permissionEntries.length === 1
            ? `文件权限 - ${permissionEntries[0].name}`
            : `修改 ${permissionEntries.length} 个项目的权限`
        }
        visible={permissionEntries.length > 0}
      >
        <Input
          addBefore="权限"
          autoFocus
          maxLength={4}
          onChange={(value) =>
            setPermissionValue(value.replace(/[^0-7]/g, "").slice(0, 4))
          }
          onPressEnter={() => void updatePermissions()}
          placeholder="755"
          status={
            permissionValue && parsePermissions(permissionValue) === null
              ? "error"
              : undefined
          }
          value={permissionValue}
        />
      </Modal>
      <Modal
        confirmLoading={operationLoading}
        maskClosable={false}
        onCancel={() => {
          setRenamingEntry(null);
          setRenameName("");
        }}
        onOk={() => void renameEntry()}
        title="重命名"
        visible={Boolean(renamingEntry)}
      >
        <Input
          autoFocus
          onChange={setRenameName}
          onPressEnter={() => void renameEntry()}
          placeholder="新名称"
          value={renameName}
        />
      </Modal>
    </section>
  );
}

export default SftpPanel;
