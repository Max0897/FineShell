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
  Spin,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  IconApps,
  IconArrowUp,
  IconCode,
  IconDelete,
  IconDown,
  IconDownload,
  IconDesktop,
  IconEdit,
  IconExclamationCircle,
  IconFile,
  IconFolder,
  IconFolderAdd,
  IconHistory,
  IconLock,
  IconLaunch,
  IconPause,
  IconPlayArrow,
  IconRefresh,
  IconStop,
  IconSync,
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
  isActiveSftpTransfer,
  isValidRemoteName,
  localFileName,
  parsePermissions,
  remoteJoinPath,
  remoteParentPath,
} from "../sftp-utils";
import type { SftpTransferStatus } from "../sftp-utils";
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
  externalEditorName: string;
  externalEditorPath: string;
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
  status: Exclude<SftpTransferStatus, "queued">;
  error?: string;
}

interface TransferRecord extends Omit<SftpTransferPayload, "status"> {
  status: SftpTransferStatus;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  sampledAt: number;
  sampledBytes: number;
  bytesPerSecond: number;
}

interface LocalUploadFile {
  path: string;
  name: string;
  size: number;
}

interface RemoteTextFile {
  path: string;
  content: string;
  size: number;
  modifiedAt?: number;
  permissions?: number;
}

interface TextEditorState {
  entry: SftpEntry;
  document: RemoteTextFile | null;
  content: string;
  loading: boolean;
  saving: boolean;
}

type ExternalEditStatus =
  | "watching"
  | "syncing"
  | "synced"
  | "conflict"
  | "failed"
  | "closed";

interface ExternalEditPayload {
  editId: string;
  sessionId: string;
  remotePath: string;
  fileName: string;
  localPath: string;
  status: ExternalEditStatus;
  error?: string;
  updatedAt?: number;
}

interface ExternalEditResult {
  editId: string;
  localPath: string;
}

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

const MAX_CONCURRENT_TRANSFERS = 2;
const REMOTE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const REMOTE_TEXT_CONFLICT_ERROR = "远程文件已被其他程序修改";

function createTransferId() {
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTransferSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0
    ? `${formatFileSize(bytesPerSecond)}/s`
    : "正在计算";
}

function isTransferCancellation(message: string) {
  return /传输已取消|连接已取消|cancel(?:led|ed)/i.test(message);
}

function isSftpSessionFailure(message: string) {
  return /会话不存在|会话已停止|连接已关闭|connection|disconnect|socket/i.test(
    message,
  );
}

function externalEditStatusMeta(status: ExternalEditStatus) {
  return {
    watching: { label: "外部编辑中", tone: "active" },
    syncing: { label: "正在同步", tone: "syncing" },
    synced: { label: "已同步", tone: "synced" },
    conflict: { label: "同步冲突", tone: "conflict" },
    failed: { label: "同步失败", tone: "failed" },
    closed: { label: "已结束", tone: "closed" },
  }[status];
}

function formatExternalEditTime(updatedAt?: number) {
  if (!updatedAt) return "";
  return new Date(updatedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function ExternalEditStatusIcon({ edit }: { edit: ExternalEditPayload }) {
  const status = externalEditStatusMeta(edit.status);

  return (
    <Tooltip content={edit.error || status.label}>
      <span
        aria-label={status.label}
        className={`sftp-external-edit-status sftp-external-edit-status-${status.tone}`}
      >
        {edit.status === "conflict" || edit.status === "failed" ? (
          <IconExclamationCircle />
        ) : (
          <IconSync />
        )}
      </span>
    </Tooltip>
  );
}

function SftpPanel({
  confirmFileDelete,
  externalEditorName,
  externalEditorPath,
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
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [externalEdits, setExternalEdits] = useState<
    Record<string, ExternalEditPayload>
  >({});
  const [externalEditConflict, setExternalEditConflict] =
    useState<ExternalEditPayload | null>(null);
  const [externalEditActionLoading, setExternalEditActionLoading] =
    useState(false);
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const [fileDropActive, setFileDropActive] = useState(false);
  const connectingRef = useRef(new Set<string>());
  const connectedHomesRef = useRef(new Map<string, string>());
  const startingTransfersRef = useRef(new Set<string>());
  const browsersRef = useRef(browsers);
  const transfersRef = useRef(transfers);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const textEditorRequestRef = useRef(0);
  const sessionIdRef = useRef(session?.id);
  const readyRef = useRef(false);
  const queueUploadPathsRef = useRef<(paths: string[]) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    browsersRef.current = browsers;
  }, [browsers]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  sessionIdRef.current = session?.id;

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
      setTransfers((current) =>
        Object.fromEntries(
          Object.entries(current).map(([transferId, transfer]) => {
            if (
              transfer.sessionId === session.id &&
              isActiveSftpTransfer(transfer.status)
            ) {
              startingTransfersRef.current.delete(transferId);
              return [
                transferId,
                {
                  ...transfer,
                  status: "cancelled",
                  bytesPerSecond: 0,
                },
              ];
            }
            return [transferId, transfer];
          }),
        ),
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
        if (
          previous.status === "cancelled" &&
          payload.status !== "cancelled"
        ) {
          return current;
        }
        if (previous.status === "paused" && payload.status === "running") {
          return current;
        }
        const now = Date.now();
        const transferredBytes =
          (payload.status === "failed" || payload.status === "cancelled") &&
          payload.transferredBytes === 0
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
        const bytesPerSecond =
          payload.status === "paused" || payload.status === "cancelled"
            ? 0
            : shouldSample
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

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExternalEditPayload>("sftp-external-edit", ({ payload }) => {
      const record = { ...payload, updatedAt: Date.now() };
      setExternalEdits((current) => {
        if (payload.status === "closed") {
          const next = { ...current };
          delete next[payload.editId];
          return next;
        }
        const next = Object.fromEntries(
          Object.entries(current).filter(
            ([editId, edit]) =>
              editId === payload.editId ||
              edit.sessionId !== payload.sessionId ||
              edit.remotePath !== payload.remotePath,
          ),
        );
        return { ...next, [payload.editId]: record };
      });

      if (payload.status === "conflict") {
        if (payload.sessionId === sessionIdRef.current) {
          setExternalEditConflict(record);
        }
      } else if (payload.status === "synced" || payload.status === "closed") {
        setExternalEditConflict((current) =>
          current?.editId === payload.editId ? null : current,
        );
      } else if (
        payload.status === "failed" &&
        payload.sessionId === sessionIdRef.current &&
        payload.error
      ) {
        Message.error(payload.error);
      }
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
  readyRef.current = ready;
  const busy =
    browser?.status === "connecting" || browser?.status === "loading";
  const currentTransfers = useMemo(
    () =>
      Object.values(transfers)
        .filter((transfer) => transfer.sessionId === session?.id)
        .reverse(),
    [session?.id, transfers],
  );
  const currentExternalEdits = useMemo(
    () =>
      Object.values(externalEdits)
        .filter((edit) => edit.sessionId === session?.id)
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    [externalEdits, session?.id],
  );
  const transferActivityCount =
    currentTransfers.length + currentExternalEdits.length;
  const visibleEntries = useMemo(
    () =>
      (browser?.entries ?? []).filter(
        (entry) => showHiddenFiles || !entry.name.startsWith("."),
      ),
    [browser?.entries, showHiddenFiles],
  );
  const selectedEntries = useMemo(
    () =>
      visibleEntries.filter((entry) => selectedEntryKeys.includes(entry.id)),
    [selectedEntryKeys, visibleEntries],
  );
  const textEditorByteLength = useMemo(
    () =>
      textEditor ? new TextEncoder().encode(textEditor.content).byteLength : 0,
    [textEditor],
  );

  useEffect(() => {
    setSelectedEntryKeys([]);
  }, [browser?.path, session?.id]);

  useEffect(() => {
    textEditorRequestRef.current += 1;
    setTextEditor(null);
  }, [session?.id]);

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
        render: (_, entry) => {
          const externalEdit = Object.values(externalEdits).find(
            (edit) =>
              edit.sessionId === session?.id &&
              edit.remotePath === entry.path &&
              edit.status !== "closed",
          );
          return (
            <div className="sftp-name-cell">
              {entry.kind === "directory" ? <IconFolder /> : <IconFile />}
              <Typography.Text ellipsis>{entry.name}</Typography.Text>
              {externalEdit && <ExternalEditStatusIcon edit={externalEdit} />}
            </div>
          );
        },
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
    [externalEdits, session?.id],
  );

  const executeTransfer = useCallback(
    async (transfer: TransferRecord) => {
      try {
        await invoke(
          transfer.direction === "upload" ? "sftp_upload" : "sftp_download",
          {
            sessionId: transfer.sessionId,
            transferId: transfer.transferId,
            localPath: transfer.localPath,
            remotePath: transfer.remotePath,
            overwrite: transfer.overwrite,
          },
        );
        Message.success(
          `${transfer.direction === "upload" ? "上传" : "下载"}完成：${transfer.fileName}`,
        );
        const currentBrowser = browsersRef.current[transfer.sessionId];
        if (transfer.direction === "upload" && currentBrowser) {
          await loadDirectory(transfer.sessionId, currentBrowser.path);
        }
      } catch (error) {
        const message = String(error);
        const cancelled =
          isTransferCancellation(message) ||
          transfersRef.current[transfer.transferId]?.status === "cancelled";
        setTransfers((current) => {
          const previous = current[transfer.transferId] ?? transfer;
          return {
            ...current,
            [transfer.transferId]: {
              ...previous,
              status: cancelled ? "cancelled" : "failed",
              error: cancelled ? undefined : message,
              bytesPerSecond: 0,
            },
          };
        });
        if (!cancelled) {
          if (isSftpSessionFailure(message)) {
            connectedHomesRef.current.delete(transfer.sessionId);
            updateBrowser(transfer.sessionId, {
              status: "failed",
              error: message,
            });
          }
          Message.error(message);
        }
      } finally {
        startingTransfersRef.current.delete(transfer.transferId);
      }
    },
    [loadDirectory, updateBrowser],
  );

  useEffect(() => {
    if (!isTauri()) return;
    const activeCounts = new Map<string, number>();
    for (const transfer of Object.values(transfers)) {
      if (transfer.status === "running" || transfer.status === "paused") {
        activeCounts.set(
          transfer.sessionId,
          (activeCounts.get(transfer.sessionId) ?? 0) + 1,
        );
      }
    }

    for (const transfer of Object.values(transfers)) {
      if (
        transfer.status !== "queued" ||
        startingTransfersRef.current.has(transfer.transferId) ||
        !connectedHomesRef.current.has(transfer.sessionId)
      ) {
        continue;
      }
      const activeCount = activeCounts.get(transfer.sessionId) ?? 0;
      if (activeCount >= MAX_CONCURRENT_TRANSFERS) continue;

      startingTransfersRef.current.add(transfer.transferId);
      activeCounts.set(transfer.sessionId, activeCount + 1);
      const runningTransfer = { ...transfer, status: "running" as const };
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: runningTransfer,
      }));
      void executeTransfer(runningTransfer);
    }
  }, [executeTransfer, transfers]);

  function runTransfer(
    direction: "upload" | "download",
    localPath: string,
    remotePath: string,
    overwrite: boolean,
    transferId = createTransferId(),
    totalBytes = 0,
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
      totalBytes,
      status: "queued",
      localPath,
      remotePath,
      overwrite,
      sampledAt: Date.now(),
      sampledBytes: 0,
      bytesPerSecond: 0,
    };
    setTransfers((current) => ({ ...current, [transferId]: record }));
  }

  function confirmBatchOverwrite(title: string, content: string) {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      Modal.confirm({
        title,
        content,
        okText: "继续",
        cancelText: "取消",
        onOk: () => finish(true),
        onCancel: () => finish(false),
      });
    });
  }

  async function queueUploadPaths(paths: string[]) {
    if (!session || !browser || !ready) return;
    let inspected: LocalUploadFile[];
    try {
      inspected = await invoke<LocalUploadFile[]>(
        "sftp_inspect_upload_paths",
        { paths },
      );
    } catch (error) {
      Message.error(String(error));
      return;
    }
    if (inspected.length < paths.length) {
      Message.warning(`已跳过 ${paths.length - inspected.length} 个目录或无效路径`);
    }
    if (inspected.length === 0) {
      Message.warning("没有可上传的文件");
      return;
    }

    const uniqueFiles = new Map<string, LocalUploadFile>();
    for (const file of inspected) {
      if (!uniqueFiles.has(file.name)) {
        uniqueFiles.set(file.name, file);
      }
    }
    if (uniqueFiles.size < inspected.length) {
      Message.warning(`已跳过 ${inspected.length - uniqueFiles.size} 个同名文件`);
    }
    const files = [...uniqueFiles.values()];
    const existingNames = new Set(browser.entries.map((entry) => entry.name));
    const conflictCount = files.filter((file) =>
      existingNames.has(file.name),
    ).length;
    if (
      conflictCount > 0 &&
      !(await confirmBatchOverwrite(
        "覆盖远程文件？",
        `有 ${conflictCount} 个同名文件，继续后将统一覆盖。`,
      ))
    ) {
      return;
    }

    for (const file of files) {
      runTransfer(
        "upload",
        file.path,
        remoteJoinPath(browser.path, file.name),
        existingNames.has(file.name),
        undefined,
        file.size,
      );
    }
    Message.info(`已加入 ${files.length} 个上传任务`);
  }

  queueUploadPathsRef.current = queueUploadPaths;

  async function chooseUploadFiles() {
    if (!session || !browser || !ready) return;
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
    if (!session || !ready) return;
    const target = await save({
      defaultPath: entry.name,
      title: `下载 ${entry.name}`,
    });
    if (!target) return;
    runTransfer("download", target, entry.path, true, undefined, entry.size);
  }

  async function downloadEntries(entries: SftpEntry[]) {
    const files = entries.filter((entry) => entry.kind !== "directory");
    if (files.length === 0) {
      Message.warning("请选择需要下载的文件");
      return;
    }
    if (files.length < entries.length) {
      Message.warning(`已跳过 ${entries.length - files.length} 个目录`);
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
      !(await confirmBatchOverwrite(
        "开始批量下载？",
        `将下载 ${files.length} 个文件，同名本地文件将统一覆盖。`,
      ))
    ) {
      return;
    }

    for (const entry of files) {
      runTransfer(
        "download",
        await join(targetDirectory, entry.name),
        entry.path,
        true,
        undefined,
        entry.size,
      );
    }
    setSelectedEntryKeys([]);
    Message.info(`已加入 ${files.length} 个下载任务`);
  }

  async function retryTransfer(transfer: TransferRecord) {
    runTransfer(
      transfer.direction,
      transfer.localPath,
      transfer.remotePath,
      transfer.overwrite,
      transfer.transferId,
      transfer.totalBytes,
    );
  }

  async function pauseTransfer(transfer: TransferRecord) {
    if (transfer.status !== "running") return;
    try {
      await invoke("sftp_pause_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || previous.status !== "running") return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "paused",
            bytesPerSecond: 0,
          },
        };
      });
    } catch (error) {
      Message.error(String(error));
    }
  }

  async function resumeTransfer(transfer: TransferRecord) {
    if (transfer.status !== "paused") return;
    try {
      await invoke("sftp_resume_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || previous.status !== "paused") return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "running",
            sampledAt: Date.now(),
            sampledBytes: previous.transferredBytes,
          },
        };
      });
    } catch (error) {
      Message.error(String(error));
    }
  }

  async function cancelTransfer(transfer: TransferRecord) {
    if (transfer.status === "queued") {
      startingTransfersRef.current.delete(transfer.transferId);
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: {
          ...transfer,
          status: "cancelled",
          bytesPerSecond: 0,
        },
      }));
      return;
    }
    if (transfer.status !== "running" && transfer.status !== "paused") return;
    try {
      await invoke("sftp_cancel_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || !isActiveSftpTransfer(previous.status)) return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "cancelled",
            bytesPerSecond: 0,
          },
        };
      });
    } catch (error) {
      Message.error(String(error));
    }
  }

  function clearFinishedTransfers() {
    if (!session) return;
    setTransfers((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([, transfer]) =>
            transfer.sessionId !== session.id ||
            isActiveSftpTransfer(transfer.status),
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

  function resetTextEditor() {
    textEditorRequestRef.current += 1;
    setTextEditor(null);
  }

  function requestCloseTextEditor() {
    if (!textEditor || textEditor.saving) return;
    if (
      textEditor.document &&
      textEditor.content !== textEditor.document.content
    ) {
      Modal.confirm({
        cancelText: "继续编辑",
        content: "当前修改尚未保存，关闭后将丢失这些内容。",
        okButtonProps: { status: "danger" },
        okText: "放弃修改",
        onOk: resetTextEditor,
        title: "放弃未保存的修改？",
      });
      return;
    }
    resetTextEditor();
  }

  async function openTextEditor(entry: SftpEntry) {
    if (!session || entry.kind !== "file") return;
    const requestId = textEditorRequestRef.current + 1;
    textEditorRequestRef.current = requestId;
    setTextEditor({
      entry,
      document: null,
      content: "",
      loading: true,
      saving: false,
    });
    try {
      const document = await invoke<RemoteTextFile>("sftp_read_text_file", {
        sessionId: session.id,
        path: entry.path,
      });
      if (textEditorRequestRef.current !== requestId) return;
      setTextEditor({
        entry,
        document,
        content: document.content,
        loading: false,
        saving: false,
      });
    } catch (error) {
      if (textEditorRequestRef.current !== requestId) return;
      setTextEditor(null);
      handleOperationError(error);
    }
  }

  async function saveTextEditor(overwrite = false) {
    if (
      !session ||
      !browser ||
      !textEditor ||
      textEditor.loading ||
      textEditor.saving
    ) {
      return;
    }
    const document = textEditor.document;
    if (!document) return;
    if (textEditorByteLength > REMOTE_TEXT_MAX_BYTES) {
      Message.error("编辑后的文本超过 2 MiB，无法保存");
      return;
    }
    if (textEditor.content === document.content) {
      return;
    }

    const editor = textEditor;
    setTextEditor((current) =>
      current
        ? {
            ...current,
            saving: true,
          }
        : current,
    );
    try {
      await invoke<RemoteTextFile>("sftp_write_text_file", {
        sessionId: session.id,
        path: editor.entry.path,
        content: editor.content,
        originalContent: document.content,
        overwrite,
      });
      resetTextEditor();
      Message.success(`已保存 ${editor.entry.name}`);
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      const message = String(error);
      setTextEditor((current) =>
        current
          ? {
              ...current,
              saving: false,
            }
          : current,
      );
      if (!overwrite && message.includes(REMOTE_TEXT_CONFLICT_ERROR)) {
        Modal.confirm({
          cancelText: "取消",
          content: "远程内容已发生变化。强制保存会覆盖其他程序写入的内容。",
          okButtonProps: { status: "danger" },
          okText: "覆盖保存",
          onOk: () => saveTextEditor(true),
          title: "远程文件已修改",
        });
      } else {
        handleOperationError(error);
      }
    }
  }

  function externalEditForEntry(entry: SftpEntry) {
    return Object.values(externalEdits).find(
      (edit) =>
        edit.sessionId === session?.id &&
        edit.remotePath === entry.path &&
        edit.status !== "closed",
    );
  }

  async function openExternalEditor(entry: SftpEntry, editorPath?: string) {
    if (!session || entry.kind !== "file") return;
    try {
      const edit = await invoke<ExternalEditResult>("sftp_start_external_edit", {
        sessionId: session.id,
        path: entry.path,
      });
      if (editorPath) {
        await invoke("sftp_launch_external_editor", {
          editId: edit.editId,
          editorPath,
        });
      } else {
        await openPath(edit.localPath);
      }
      Message.success(`已打开 ${entry.name}，保存后将自动同步`);
    } catch (error) {
      handleOperationError(error);
    }
  }

  async function chooseExternalEditor(entry: SftpEntry) {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: "选择外部编辑器",
      });
      if (typeof selected === "string") {
        await openExternalEditor(entry, selected);
      }
    } catch (error) {
      handleOperationError(error);
    }
  }

  async function resolveExternalEdit(action: "overwrite" | "reload") {
    if (!externalEditConflict || !session || !browser) return;
    setExternalEditActionLoading(true);
    try {
      await invoke("sftp_external_edit_action", {
        editId: externalEditConflict.editId,
        action,
      });
      Message.success(
        action === "overwrite"
          ? "本地内容已覆盖远端文件"
          : "已用远端内容更新本地文件",
      );
      setExternalEditConflict(null);
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setExternalEditActionLoading(false);
    }
  }

  async function reopenExternalEditLocalFile(edit: ExternalEditPayload) {
    try {
      await openPath(edit.localPath);
    } catch (error) {
      Message.error(`无法打开本地编辑副本：${String(error)}`);
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
      if (singleEntry.kind === "file") {
        const activeEdit = externalEditForEntry(singleEntry);
        const openItems: ContextMenuItem[] = [
          {
            key: "open-internal",
            label: "内置编辑器",
            icon: <IconCode />,
            disabled: operationLoading,
            onClick: () => openTextEditor(singleEntry),
          },
          {
            key: "open-default",
            label: "系统默认应用",
            icon: <IconDesktop />,
            disabled: operationLoading,
            onClick: () => openExternalEditor(singleEntry),
          },
        ];
        if (externalEditorPath) {
          openItems.push({
            key: "open-configured",
            label: externalEditorName || "已配置编辑器",
            icon: <IconLaunch />,
            disabled: operationLoading,
            onClick: () =>
              openExternalEditor(singleEntry, externalEditorPath),
          });
        }
        openItems.push({
          key: "open-other",
          label: "选择其他应用...",
          icon: <IconApps />,
          disabled: operationLoading,
          onClick: () => chooseExternalEditor(singleEntry),
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
            onClick: () => setExternalEditConflict(activeEdit),
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
        onClick: () => downloadEntry(singleEntry),
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
        onClick: () => downloadEntries(entries),
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

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let scaleFactor = 1;

    void getCurrentWindow()
      .scaleFactor()
      .then((value) => {
        scaleFactor = value;
      });
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setFileDropActive(false);
          return;
        }
        const rect = dropZoneRef.current?.getBoundingClientRect();
        const position = payload.position;
        const x = position.x / scaleFactor;
        const y = position.y / scaleFactor;
        const inside = Boolean(
          readyRef.current &&
            rect &&
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom,
        );
        if (payload.type === "drop") {
          setFileDropActive(false);
          if (inside) {
            void queueUploadPathsRef.current(payload.paths);
          }
          return;
        }
        setFileDropActive(inside);
      })
      .then((stopListening) => {
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
          <Tooltip content="下载所选文件">
            <Button
              aria-label="下载所选文件"
              disabled={
                !ready ||
                !selectedEntries.some((entry) => entry.kind !== "directory")
              }
              icon={<IconDownload />}
              onClick={() => void downloadEntries(selectedEntries)}
              size="mini"
            />
          </Tooltip>
          <Button
            disabled={!ready}
            icon={<IconUpload />}
            onClick={() => void chooseUploadFiles()}
            size="mini"
            type="primary"
          >
            上传
          </Button>
          <Tooltip content="传输记录">
            <Badge count={transferActivityCount} maxCount={99}>
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
          <div
            className={`sftp-table-container${fileDropActive ? " sftp-table-container-drop-active" : ""}`}
            ref={dropZoneRef}
          >
            {fileDropActive && (
              <div className="sftp-file-drop-overlay">
                <IconUpload />
                <span>释放以上传文件</span>
              </div>
            )}
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
                onDoubleClick: () => {
                  if (entry.kind === "directory") {
                    openDirectory(entry);
                  } else if (entry.kind === "file") {
                    void openTextEditor(entry);
                  }
                },
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
        title={
          <div className="sftp-transfer-drawer-title">
            <span>传输记录</span>
            {currentTransfers.some(
              (item) => !isActiveSftpTransfer(item.status),
            ) && (
              <Tooltip content="清除已结束记录">
                <Button
                  aria-label="清除已结束传输和同步记录"
                  icon={<IconDelete />}
                  onClick={clearFinishedTransfers}
                  size="mini"
                  type="text"
                />
              </Tooltip>
            )}
          </div>
        }
        visible={transferDrawerVisible}
        width={440}
      >
        {transferActivityCount === 0 ? (
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
                    : transfer.status === "cancelled"
                      ? "已取消"
                      : transfer.status === "paused"
                        ? "已暂停"
                        : transfer.status === "queued"
                          ? "等待中"
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
                  <div className="sftp-transfer-actions">
                    {transfer.status === "running" && (
                      <Tooltip content="暂停">
                        <Button
                          aria-label={`暂停 ${transfer.fileName}`}
                          icon={<IconPause />}
                          onClick={() => void pauseTransfer(transfer)}
                          size="mini"
                          type="text"
                        />
                      </Tooltip>
                    )}
                    {transfer.status === "paused" && (
                      <Tooltip content="继续">
                        <Button
                          aria-label={`继续 ${transfer.fileName}`}
                          icon={<IconPlayArrow />}
                          onClick={() => void resumeTransfer(transfer)}
                          size="mini"
                          type="text"
                        />
                      </Tooltip>
                    )}
                    {isActiveSftpTransfer(transfer.status) && (
                      <Tooltip content="取消">
                        <Button
                          aria-label={`取消 ${transfer.fileName}`}
                          icon={<IconStop />}
                          onClick={() => void cancelTransfer(transfer)}
                          size="mini"
                          type="text"
                        />
                      </Tooltip>
                    )}
                    {transfer.status === "failed" && (
                      <Tooltip content="重试">
                        <Button
                          aria-label={`重试 ${transfer.fileName}`}
                          icon={<IconRefresh />}
                          onClick={() => void retryTransfer(transfer)}
                          size="mini"
                        />
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
            {currentExternalEdits.map((edit) => {
              const status = externalEditStatusMeta(edit.status);
              const hasProblem =
                edit.status === "conflict" || edit.status === "failed";
              const updatedAt = formatExternalEditTime(edit.updatedAt);
              return (
                <div
                  className="sftp-transfer-row sftp-sync-row"
                  key={edit.editId}
                >
                  <span
                    className={`sftp-transfer-direction sftp-transfer-direction-sync sftp-transfer-direction-sync-${status.tone}`}
                  >
                    {hasProblem ? (
                      <IconExclamationCircle />
                    ) : (
                      <IconSync />
                    )}
                  </span>
                  <div className="sftp-transfer-content">
                    <div className="sftp-transfer-title-row">
                      <Typography.Text
                        className="sftp-transfer-file-name"
                        ellipsis={{ showTooltip: true }}
                      >
                        {edit.fileName}
                      </Typography.Text>
                    </div>
                    <div className="sftp-transfer-meta">
                      <Typography.Text
                        className="sftp-sync-path"
                        ellipsis={{ showTooltip: true }}
                        type="secondary"
                      >
                        {edit.remotePath}
                      </Typography.Text>
                      <Typography.Text
                        className={`sftp-transfer-activity sftp-sync-activity-${status.tone}`}
                        type={edit.status === "failed" ? "error" : "secondary"}
                      >
                        {updatedAt
                          ? `${status.label} · ${updatedAt}`
                          : status.label}
                      </Typography.Text>
                    </div>
                    {hasProblem && edit.error && (
                      <Typography.Text
                        className="sftp-transfer-error"
                        ellipsis={{ showTooltip: true }}
                        type={edit.status === "failed" ? "error" : "secondary"}
                      >
                        {edit.error}
                      </Typography.Text>
                    )}
                  </div>
                  <div className="sftp-transfer-actions">
                    <Tooltip content="打开本地副本">
                      <Button
                        aria-label={`打开 ${edit.fileName} 的本地副本`}
                        icon={<IconLaunch />}
                        onClick={() => void reopenExternalEditLocalFile(edit)}
                        size="mini"
                        type="text"
                      />
                    </Tooltip>
                    {hasProblem && (
                      <Tooltip content="处理同步问题">
                        <Button
                          aria-label={`处理 ${edit.fileName} 的同步问题`}
                          icon={<IconExclamationCircle />}
                          onClick={() => setExternalEditConflict(edit)}
                          size="mini"
                          type="text"
                        />
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Drawer>
      <Modal
        cancelButtonProps={{ disabled: Boolean(textEditor?.saving) }}
        className="sftp-text-editor-modal"
        confirmLoading={Boolean(textEditor?.saving)}
        maskClosable={false}
        okButtonProps={{
          disabled: Boolean(
            textEditor?.loading ||
              !textEditor?.document ||
              textEditor.content === textEditor.document.content ||
              textEditorByteLength > REMOTE_TEXT_MAX_BYTES,
          ),
        }}
        okText="保存"
        onCancel={requestCloseTextEditor}
        onOk={() => void saveTextEditor()}
        title={textEditor ? `编辑文本 - ${textEditor.entry.name}` : "编辑文本"}
        visible={Boolean(textEditor)}
      >
        <div className="sftp-text-editor-body">
          <div className="sftp-text-editor-meta">
            <Typography.Text ellipsis={{ showTooltip: true }} type="secondary">
              {textEditor?.entry.path ?? ""}
            </Typography.Text>
            <Typography.Text
              type={
                textEditorByteLength > REMOTE_TEXT_MAX_BYTES
                  ? "error"
                  : "secondary"
              }
            >
              {formatFileSize(textEditorByteLength)} / 2 MiB
            </Typography.Text>
          </div>
          <div className="sftp-text-editor-field">
            <Input.TextArea
              aria-label="远程文本内容"
              className="sftp-text-editor-input"
              disabled={Boolean(textEditor?.loading || textEditor?.saving)}
              onChange={(content) =>
                setTextEditor((current) =>
                  current
                    ? {
                        ...current,
                        content,
                      }
                    : current,
                )
              }
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  void saveTextEditor();
                }
              }}
              placeholder={textEditor?.loading ? "正在读取远程文件..." : ""}
              spellCheck={false}
              value={textEditor?.content ?? ""}
            />
            {textEditor?.loading && (
              <div className="sftp-text-editor-loading">
                <Spin />
              </div>
            )}
          </div>
        </div>
      </Modal>
      <Modal
        footer={
          <Space>
            <Button
              disabled={externalEditActionLoading}
              onClick={() => setExternalEditConflict(null)}
            >
              保留本地
            </Button>
            <Button
              disabled={externalEditActionLoading}
              onClick={() => void resolveExternalEdit("reload")}
            >
              重新加载远端
            </Button>
            <Button
              loading={externalEditActionLoading}
              onClick={() => void resolveExternalEdit("overwrite")}
              status="danger"
              type="primary"
            >
              覆盖远端
            </Button>
          </Space>
        }
        maskClosable={false}
        onCancel={() => setExternalEditConflict(null)}
        title={
          externalEditConflict?.status === "failed"
            ? "自动同步失败"
            : "远程文件已修改"
        }
        visible={Boolean(externalEditConflict)}
      >
        <div className="sftp-external-edit-conflict">
          <Typography.Paragraph>
            {externalEditConflict?.error ||
              "远端文件在本地编辑期间发生了变化。"}
          </Typography.Paragraph>
          <Typography.Text ellipsis={{ showTooltip: true }} type="secondary">
            {externalEditConflict?.remotePath ?? ""}
          </Typography.Text>
        </div>
      </Modal>
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
