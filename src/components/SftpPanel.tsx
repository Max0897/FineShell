import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Empty,
  Message,
  Modal,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  IconExclamationCircle,
  IconFile,
  IconFolder,
  IconRefresh,
  IconSync,
  IconUpload,
} from "@arco-design/web-react/icon";
import type {
  SftpConnectResult,
  SftpEntry,
  SftpListResult,
  TerminalSession,
} from "../models";
import { MAX_SFTP_BOOKMARKS } from "../config-database";
import ContextMenu from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import {
  MAX_AI_REMOTE_FILES,
  MAX_AI_REMOTE_FILES_BYTES,
  aiRemoteFileContextError,
  type AiRemoteFileContext,
} from "../ai-utils";
import {
  formatFileSize,
  formatPermissions,
  formatRemoteTime,
  isRemotePathDescendant,
  isValidRemoteName,
  invertSftpEntryKeys,
  localFileName,
  matchRemoteDirectoryPaths,
  nextAvailableRemoteName,
  nextAvailableRemoteArchiveName,
  parsePermissions,
  remoteArchiveBaseName,
  remoteArchiveFileName,
  remoteArchiveFormatFromName,
  remoteJoinPath,
  remoteParentPath,
  selectAllSftpEntryKeys,
  setRemotePathBookmark,
} from "../sftp-utils";
import type { RemoteArchiveFormat } from "../sftp-utils";
import { jumpHostRequest, sshCredentialId } from "../terminal-utils";
import {
  commandErrorMessage,
  type ExternalEditPayload,
} from "../tauri-protocol";
import {
  externalEditStatusMeta,
} from "./TransferActivityList";
import {
  ArchiveDialog,
  CreateEntryDialog,
  ExternalEditConflictDialog,
  PasteConflictDialog,
  PermissionsDialog,
  RenameDialog,
  TextEditorDialog,
  type ArchiveDialogState,
  type CreateEntryKind,
  type PasteConflictPolicy,
  type RemoteTextFile,
} from "./sftp/SftpDialogs";
import SftpTransferDrawer from "./sftp/SftpTransferDrawer";
import buildSftpContextMenu from "./sftp/buildSftpContextMenu";
import SftpToolbar from "./sftp/SftpToolbar";
import useNativeSftpDrop from "./sftp/useNativeSftpDrop";
import { isSftpSessionFailure } from "./sftp/sftpErrors";
import useSftpLocations from "./sftp/useSftpLocations";
import useSftpRemoteDrag from "./sftp/useSftpRemoteDrag";
import useSftpTextEditing, {
  REMOTE_TEXT_MAX_BYTES,
} from "./sftp/useSftpTextEditing";
import useSftpTransfers from "./sftp/useSftpTransfers";
import {
  isEditableSelectAllTarget,
  SELECT_ALL_REQUEST_EVENT,
  type SelectAllRequestDetail,
} from "../select-all-shortcut";

type BrowserStatus = "idle" | "connecting" | "loading" | "ready" | "failed";
type SftpClipboardMode = "copy" | "cut";

interface BrowserState {
  status: BrowserStatus;
  path: string;
  inputPath: string;
  entries: SftpEntry[];
  error?: string;
}

interface SftpClipboard {
  mode: SftpClipboardMode;
  entries: SftpEntry[];
}

interface PendingPaste {
  targetDirectory: string;
  clipboard: SftpClipboard;
  conflictCount: number;
}

interface SftpPanelProps {
  confirmFileDelete: boolean;
  externalEditorName: string;
  externalEditorPath: string;
  onCurrentPathChange: (sessionId: string | null, path: string) => void;
  onSendFilesToAi: (
    sessionId: string,
    files: AiRemoteFileContext[],
  ) => void | Promise<void>;
  onSendSelectionToAi: (
    sessionId: string,
    currentDirectory: string,
    entries: SftpEntry[],
  ) => void | Promise<void>;
  refreshRequest: number;
  session: TerminalSession | null;
  showHiddenFiles: boolean;
  terminalDirectory?: { path: string; revision: number };
}

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

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

function createUploadBatchId() {
  return `upload-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  onCurrentPathChange,
  onSendFilesToAi,
  onSendSelectionToAi,
  refreshRequest,
  session,
  showHiddenFiles,
  terminalDirectory,
}: SftpPanelProps) {
  const [browsers, setBrowsers] = useState<Record<string, BrowserState>>({});
  const [transferDrawerVisible, setTransferDrawerVisible] = useState(false);
  const [creatingEntryKind, setCreatingEntryKind] =
    useState<CreateEntryKind | null>(null);
  const [newEntryName, setNewEntryName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [permissionEntries, setPermissionEntries] = useState<SftpEntry[]>([]);
  const [permissionValue, setPermissionValue] = useState("");
  const [permissionOwner, setPermissionOwner] = useState("");
  const [permissionGroup, setPermissionGroup] = useState("");
  const parsedPermissionValue = parsePermissions(permissionValue);
  const [operationLoading, setOperationLoading] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(
    null,
  );
  const [archiveBaseName, setArchiveBaseName] = useState("");
  const [archiveFormat, setArchiveFormat] =
    useState<RemoteArchiveFormat>("tarGz");
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const [clipboards, setClipboards] = useState<Record<string, SftpClipboard>>(
    {},
  );
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [pasteConflictPolicy, setPasteConflictPolicy] =
    useState<PasteConflictPolicy>("rename");
  const connectingRef = useRef(new Set<string>());
  const connectedHomesRef = useRef(new Map<string, string>());
  const handledRefreshRequestsRef = useRef<Record<string, number>>({});
  const handledTerminalDirectoryRevisionsRef = useRef(
    new Map<string, number>(),
  );
  const browsersRef = useRef(browsers);
  const panelRef = useRef<HTMLElement>(null);
  const sessionHostIdsRef = useRef(new Map<string, string>());
  const { commitLocation, locationForHost, recordVisitedPath } =
    useSftpLocations();

  useEffect(() => {
    browsersRef.current = browsers;
  }, [browsers]);

  if (session) {
    sessionHostIdsRef.current.set(session.id, session.host.id);
  }

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
        const hostId = sessionHostIdsRef.current.get(sessionId);
        if (hostId) recordVisitedPath(hostId, result.path);
      } catch (error) {
        const message = commandErrorMessage(error);
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
    [recordVisitedPath, updateBrowser],
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
              connectTimeoutSeconds: currentSession.host.connectTimeoutSeconds,
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
          error: commandErrorMessage(error),
        });
      } finally {
        connectingRef.current.delete(currentSession.id);
      }
    },
    [loadDirectory, updateBrowser],
  );

  const {
    cancel: cancelTransfer,
    cancelSessionTransfers,
    clearFinished: clearFinishedTransfersForSession,
    currentTransfers,
    pause: pauseTransfer,
    queueArchiveDownload,
    queueTransfer,
    resume: resumeTransfer,
    retry: retryTransfer,
  } = useSftpTransfers({
    activeSessionId: session?.id,
    isSessionReady: (sessionId) => connectedHomesRef.current.has(sessionId),
    onRefreshDirectory: async (sessionId) => {
      const currentBrowser = browsersRef.current[sessionId];
      if (currentBrowser?.status === "ready") {
        await loadDirectory(sessionId, currentBrowser.path);
      }
    },
    onSessionFailure: (sessionId, message) => {
      connectedHomesRef.current.delete(sessionId);
      updateBrowser(sessionId, { status: "failed", error: message });
    },
  });

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
      cancelSessionTransfers(session.id);
      updateBrowser(session.id, {
        status: "idle",
        entries: [],
        error: undefined,
      });
      setClipboards((current) => {
        if (!current[session.id]) return current;
        const next = { ...current };
        delete next[session.id];
        return next;
      });
    }
  }, [
    browsers,
    cancelSessionTransfers,
    connectAndLoad,
    session,
    updateBrowser,
  ]);

  useEffect(() => {
    if (!session || refreshRequest <= 0) return;
    if (
      (handledRefreshRequestsRef.current[session.id] ?? 0) >= refreshRequest
    ) {
      return;
    }
    const browser = browsers[session.id];
    if (!browser || browser.status !== "ready") return;
    handledRefreshRequestsRef.current[session.id] = refreshRequest;
    void loadDirectory(session.id, browser.path);
  }, [browsers, loadDirectory, refreshRequest, session]);

  const browser = session ? (browsers[session.id] ?? INITIAL_BROWSER) : null;
  const connected = session?.status === "connected";
  const ready = Boolean(connected && browser?.status === "ready");
  const busy =
    browser?.status === "connecting" || browser?.status === "loading";
  const {
    chooseExternalEditor,
    currentExternalEdits,
    externalEditActionLoading,
    externalEditConflict,
    externalEditForEntry,
    externalEdits,
    openExternalEditor,
    openTextEditor,
    reopenExternalEditLocalFile,
    requestCloseTextEditor,
    resolveExternalEdit,
    selectExternalEditConflict,
    saveTextEditor,
    textEditor,
    textEditorByteLength,
    updateTextContent,
  } = useSftpTextEditing({
    onOperationError: handleOperationError,
    onRefreshDirectory: () => {
      if (session && browser) {
        return loadDirectory(session.id, browser.path);
      }
    },
    sessionId: session?.id,
  });
  const currentLocation = locationForHost(session?.host.id);
  const currentPathBookmarked = Boolean(
    browser?.path && currentLocation.bookmarks.includes(browser.path),
  );
  const pathSuggestions = useMemo(
    () =>
      matchRemoteDirectoryPaths(
        currentLocation.bookmarks,
        currentLocation.history,
        browser?.inputPath ?? "",
      ),
    [browser?.inputPath, currentLocation.bookmarks, currentLocation.history],
  );
  const transferActivityCount =
    currentTransfers.length + currentExternalEdits.length;
  const currentClipboard = session ? clipboards[session.id] : undefined;
  const cutEntryPaths = useMemo(
    () =>
      new Set(
        currentClipboard?.mode === "cut"
          ? currentClipboard.entries.map((entry) => entry.path)
          : [],
      ),
    [currentClipboard],
  );
  const visibleEntries = useMemo(
    () =>
      (browser?.entries ?? []).filter(
        (entry) => showHiddenFiles || !entry.name.startsWith("."),
      ),
    [browser?.entries, showHiddenFiles],
  );

  useEffect(() => {
    if (!session) return;
    if (!terminalDirectory) {
      handledTerminalDirectoryRevisionsRef.current.delete(session.id);
      return;
    }
    if (browser?.status !== "ready") return;
    if (
      handledTerminalDirectoryRevisionsRef.current.get(session.id) ===
      terminalDirectory.revision
    ) {
      return;
    }
    handledTerminalDirectoryRevisionsRef.current.set(
      session.id,
      terminalDirectory.revision,
    );
    if (browser.path !== terminalDirectory.path) {
      void loadDirectory(session.id, terminalDirectory.path);
    }
  }, [browser?.path, browser?.status, loadDirectory, session, terminalDirectory]);

  useEffect(() => {
    onCurrentPathChange(
      session?.id ?? null,
      browser?.status === "ready" ? browser.path : "",
    );
  }, [browser?.path, browser?.status, onCurrentPathChange, session?.id]);

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

  useEffect(() => {
    const handleSelectAllRequest = (event: Event) => {
      const panel = panelRef.current;
      if (
        !ready ||
        !panel?.contains(document.activeElement) ||
        isEditableSelectAllTarget(document.activeElement)
      ) {
        return;
      }

      const request = event as CustomEvent<SelectAllRequestDetail>;
      const visibleKeys = visibleEntries.map((entry) => entry.id);
      event.preventDefault();
      setSelectedEntryKeys((current) =>
        request.detail.invert
          ? invertSftpEntryKeys(visibleKeys, current)
          : selectAllSftpEntryKeys(visibleKeys),
      );
    };
    window.addEventListener(SELECT_ALL_REQUEST_EVENT, handleSelectAllRequest);
    return () =>
      window.removeEventListener(
        SELECT_ALL_REQUEST_EVENT,
        handleSelectAllRequest,
      );
  }, [ready, visibleEntries]);

  function focusFilePanelForShortcut(event: React.PointerEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        'button, input, textarea, a, [contenteditable="true"], [role="button"], [role="checkbox"], [role="combobox"], [role="textbox"]',
      )
    ) {
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
  }

  function navigateToPath(path: string) {
    if (!session || !path.trim()) return;
    void loadDirectory(session.id, path.trim());
  }

  function toggleCurrentPathBookmark() {
    if (!session || !browser?.path) return;
    commitLocation(session.host.id, (current) => ({
      ...current,
      bookmarks: setRemotePathBookmark(
        current.bookmarks,
        browser.path,
        !current.bookmarks.includes(browser.path),
        MAX_SFTP_BOOKMARKS,
      ),
    }));
  }

  function removePathBookmark(path: string) {
    if (!session) return;
    commitLocation(session.host.id, (current) => ({
      ...current,
      bookmarks: setRemotePathBookmark(
        current.bookmarks,
        path,
        false,
        MAX_SFTP_BOOKMARKS,
      ),
    }));
  }

  function clearPathHistory() {
    if (!session) return;
    commitLocation(session.host.id, (current) => ({
      ...current,
      history: [],
    }));
  }

  const {
    cancel: cancelRemotePointerDrag,
    dropTargetPath: remoteDropTargetPath,
    finish: finishRemotePointerDrag,
    move: moveRemotePointerDrag,
    preview: remoteDragPreview,
    start: startRemotePointerDrag,
  } = useSftpRemoteDrag({
    disabled: !ready || operationLoading,
    entries: visibleEntries,
    onMove: (entries, targetDirectory) => {
      void requestPaste(targetDirectory, { mode: "cut", entries });
    },
    resetKey: `${session?.id ?? ""}\0${browser?.path ?? ""}`,
    selectedEntryKeys,
    setSelectedEntryKeys,
  });

  const columns = useMemo<TableColumnProps<SftpEntry>[]>(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        sorter: (left, right) =>
          left.name.localeCompare(right.name, "zh-CN", {
            numeric: true,
            sensitivity: "base",
          }),
        render: (_, entry) => {
          const externalEdit = Object.values(externalEdits).find(
            (edit) =>
              edit.sessionId === session?.id &&
              edit.remotePath === entry.path &&
              edit.status !== "closed",
          );
          return (
            <div
              className={`sftp-name-cell${ready && !operationLoading ? " is-draggable" : ""}`}
              onPointerCancel={cancelRemotePointerDrag}
              onPointerDown={(event) => startRemotePointerDrag(event, entry)}
              onPointerMove={moveRemotePointerDrag}
              onPointerUp={finishRemotePointerDrag}
            >
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
        sorter: (left, right) => left.size - right.size,
        width: 110,
        render: (_, entry) =>
          entry.kind === "directory" ? "-" : formatFileSize(entry.size),
      },
      {
        title: "用户 / 用户组",
        width: 140,
        render: (_, entry) =>
          entry.owner || entry.group
            ? `${entry.owner ?? "-"} / ${entry.group ?? "-"}`
            : "-",
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
        sorter: (left, right) =>
          (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0),
        width: 150,
        render: (value) => formatRemoteTime(value),
      },
    ],
    [
      externalEdits,
      cancelRemotePointerDrag,
      finishRemotePointerDrag,
      moveRemotePointerDrag,
      operationLoading,
      ready,
      selectedEntryKeys,
      session?.id,
      startRemotePointerDrag,
      visibleEntries,
    ],
  );

  function runTransfer(
    direction: "upload" | "download",
    localPath: string,
    remotePath: string,
    overwrite: boolean,
    transferId?: string,
    totalBytes = 0,
    batchId?: string,
  ) {
    if (!session) return;
    queueTransfer({
      batchId,
      direction,
      localPath,
      overwrite,
      remotePath,
      sessionId: session.id,
      transferId,
      totalBytes,
    });
  }

  function runArchiveDownload(
    localPath: string,
    sourcePaths: string[],
    format: RemoteArchiveFormat,
    archiveName: string,
    transferId?: string,
  ) {
    if (!session) return;
    queueArchiveDownload({
      archiveName,
      format,
      localPath,
      sessionId: session.id,
      sourcePaths,
      transferId,
    });
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

  async function queueUploadPaths(paths: string[], targetDirectory?: string) {
    if (!session || !browser || !ready) return;
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

    const destination = targetDirectory ?? browser.path;
    let targetEntries = browser.entries;
    if (destination !== browser.path) {
      try {
        const listing = await invoke<SftpListResult>("sftp_list", {
          sessionId: session.id,
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
      !(await confirmBatchOverwrite(
        "合并或覆盖远程项目？",
        `有 ${conflictingRoots.size} 个同名项目，目录将合并，同名文件将覆盖。`,
      ))
    ) {
      return;
    }

    try {
      await invoke("sftp_ensure_upload_directories", {
        sessionId: session.id,
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
      runTransfer(
        "upload",
        file.path,
        remoteJoinPath(destination, file.relativePath),
        conflictingRoots.has(rootName),
        undefined,
        file.size,
        batchId,
      );
    }
    if (
      destination === browser.path &&
      inspection.directories.length > 0 &&
      inspection.files.length === 0
    ) {
      await loadDirectory(session.id, browser.path);
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

  function clearFinishedTransfers() {
    if (!session) return;
    clearFinishedTransfersForSession(session.id);
  }

  function handleOperationError(error: unknown) {
    const message = commandErrorMessage(error);
    if (session && isSftpSessionFailure(message)) {
      connectedHomesRef.current.delete(session.id);
      updateBrowser(session.id, { status: "failed", error: message });
    }
    Message.error(message);
  }

  function storeClipboard(entries: SftpEntry[], mode: SftpClipboardMode) {
    if (!session || entries.length === 0) return;
    setClipboards((current) => ({
      ...current,
      [session.id]: {
        mode,
        entries: entries.map((entry) => ({ ...entry })),
      },
    }));
    Message.success(
      `${mode === "copy" ? "已复制" : "已剪切"} ${entries.length} 个项目`,
    );
  }

  async function pasteClipboard(
    clipboard: SftpClipboard,
    targetDirectory: string,
    conflictPolicy: PasteConflictPolicy,
  ) {
    if (!session || !browser || clipboard.entries.length === 0) return;
    const sessionId = session.id;
    const invalidDirectory = clipboard.entries.find(
      (entry) =>
        entry.kind === "directory" &&
        (entry.path === targetDirectory ||
          isRemotePathDescendant(entry.path, targetDirectory)),
    );
    if (invalidDirectory) {
      Message.warning(`不能将“${invalidDirectory.name}”放到其自身内部`);
      return;
    }

    setOperationLoading(true);
    let succeeded = 0;
    let skipped = 0;
    const completedSourcePaths = new Set<string>();
    const failures: string[] = [];
    try {
      const targetListing = await invoke<SftpListResult>("sftp_list", {
        sessionId,
        path: targetDirectory,
      });
      const unavailableNames = new Set(
        targetListing.entries.map((entry) => entry.name),
      );

      for (const entry of clipboard.entries) {
        let targetName = entry.name;
        let targetPath = remoteJoinPath(targetListing.path, targetName);
        if (clipboard.mode === "cut" && targetPath === entry.path) {
          skipped += 1;
          continue;
        }

        const conflicts = unavailableNames.has(targetName);
        if (conflicts && conflictPolicy === "skip") {
          skipped += 1;
          continue;
        }
        if (conflicts && conflictPolicy === "rename") {
          targetName = nextAvailableRemoteName(targetName, unavailableNames);
          targetPath = remoteJoinPath(targetListing.path, targetName);
        }

        try {
          await invoke(
            clipboard.mode === "copy" ? "sftp_copy" : "sftp_rename",
            {
              sessionId,
              sourcePath: entry.path,
              targetPath,
              overwrite: conflicts && conflictPolicy === "overwrite",
            },
          );
          unavailableNames.add(targetName);
          completedSourcePaths.add(entry.path);
          succeeded += 1;
        } catch (error) {
          failures.push(`${entry.name}：${commandErrorMessage(error)}`);
        }
      }

      if (clipboard.mode === "cut" && completedSourcePaths.size > 0) {
        setClipboards((current) => {
          const active = current[sessionId];
          if (!active || active.mode !== "cut") return current;
          const remaining = active.entries.filter(
            (entry) => !completedSourcePaths.has(entry.path),
          );
          if (remaining.length > 0) {
            return {
              ...current,
              [sessionId]: { ...active, entries: remaining },
            };
          }
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
      setSelectedEntryKeys([]);

      const activeBrowser = browsersRef.current[sessionId];
      if (activeBrowser) {
        await loadDirectory(sessionId, activeBrowser.path);
      }
      if (succeeded > 0) {
        Message.success(
          `${clipboard.mode === "copy" ? "已复制" : "已移动"} ${succeeded} 个项目`,
        );
      } else if (skipped > 0 && failures.length === 0) {
        Message.info("没有需要处理的项目");
      }
      if (failures.length > 0) {
        const remaining =
          failures.length > 1 ? `，另有 ${failures.length - 1} 项失败` : "";
        Message.error(`${failures[0]}${remaining}`);
      }
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  async function requestPaste(
    targetDirectory: string,
    clipboard = currentClipboard,
  ) {
    if (!session || !clipboard || clipboard.entries.length === 0) return;
    const invalidDirectory = clipboard.entries.find(
      (entry) =>
        entry.kind === "directory" &&
        (entry.path === targetDirectory ||
          isRemotePathDescendant(entry.path, targetDirectory)),
    );
    if (invalidDirectory) {
      Message.warning(`不能将“${invalidDirectory.name}”放到其自身内部`);
      return;
    }

    setOperationLoading(true);
    try {
      const targetListing = await invoke<SftpListResult>("sftp_list", {
        sessionId: session.id,
        path: targetDirectory,
      });
      const targetNames = new Set(
        targetListing.entries.map((entry) => entry.name),
      );
      const conflictCount = clipboard.entries.filter((entry) => {
        const targetPath = remoteJoinPath(targetListing.path, entry.name);
        return (
          !(clipboard.mode === "cut" && targetPath === entry.path) &&
          targetNames.has(entry.name)
        );
      }).length;
      if (conflictCount > 0) {
        setPasteConflictPolicy("rename");
        setPendingPaste({
          targetDirectory: targetListing.path,
          clipboard,
          conflictCount,
        });
      } else {
        await pasteClipboard(clipboard, targetListing.path, "skip");
      }
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
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

  function openArchiveDialog(
    entries: SftpEntry[],
    mode: ArchiveDialogState["mode"],
  ) {
    const suggestedBase =
      entries.length === 1 ? remoteArchiveBaseName(entries[0].name) : "archive";
    const suggestedName = nextAvailableRemoteArchiveName(
      suggestedBase || "archive",
      "tarGz",
      new Set((browser?.entries ?? []).map((entry) => entry.name)),
    );
    setArchiveFormat("tarGz");
    setArchiveBaseName(remoteArchiveBaseName(suggestedName));
    setArchiveDialog({ entries, mode });
  }

  function closeArchiveDialog() {
    setArchiveDialog(null);
    setArchiveBaseName("");
    setArchiveFormat("tarGz");
  }

  async function submitArchiveDialog() {
    if (!archiveDialog || !session || !browser) return;
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
      runArchiveDownload(target, sourcePaths, archiveFormat, archiveName);
      closeArchiveDialog();
      setSelectedEntryKeys([]);
      Message.info("已加入打包下载任务");
      return;
    }

    const targetPath = remoteJoinPath(browser.path, archiveName);
    const overwrite = browser.entries.some(
      (entry) => entry.path === targetPath,
    );
    if (
      overwrite &&
      !(await confirmBatchOverwrite(
        "覆盖已有归档？",
        `当前目录已经存在“${archiveName}”，继续后将覆盖该文件。`,
      ))
    ) {
      return;
    }

    setOperationLoading(true);
    try {
      await invoke("sftp_create_archive", {
        sessionId: session.id,
        sourcePaths,
        targetPath,
        format: archiveFormat,
        overwrite,
      });
      closeArchiveDialog();
      setSelectedEntryKeys([]);
      Message.success(`已创建 ${archiveName}`);
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  async function extractRemoteArchive(
    entry: SftpEntry,
    createDirectory: boolean,
  ) {
    if (!session || !browser) return;
    const format = remoteArchiveFormatFromName(entry.name);
    if (!format) {
      Message.warning("当前文件不是支持的归档格式");
      return;
    }
    const targetName = remoteArchiveBaseName(entry.name);
    const targetDirectory = createDirectory
      ? remoteJoinPath(browser.path, targetName)
      : browser.path;
    if (
      createDirectory &&
      browser.entries.some((candidate) => candidate.path === targetDirectory)
    ) {
      Message.warning(`目标目录“${targetName}”已存在`);
      return;
    }
    if (
      !createDirectory &&
      !(await confirmBatchOverwrite(
        "解压到当前目录？",
        "归档中的同名文件将被覆盖，该操作无法自动撤销。",
      ))
    ) {
      return;
    }

    setOperationLoading(true);
    try {
      await invoke("sftp_extract_archive", {
        sessionId: session.id,
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
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
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
    setPermissionOwner(
      entries.every((entry) => entry.owner === entries[0]?.owner)
        ? (entries[0]?.owner ?? "")
        : "",
    );
    setPermissionGroup(
      entries.every((entry) => entry.group === entries[0]?.group)
        ? (entries[0]?.group ?? "")
        : "",
    );
  }

  async function updatePermissions() {
    if (!session || !browser || permissionEntries.length === 0) return;
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

    setOperationLoading(true);
    let didUpdate = false;
    try {
      for (const entry of permissionEntries) {
        if (permissions !== null && entry.permissions !== permissions) {
          await invoke("sftp_set_permissions", {
            sessionId: session.id,
            path: entry.path,
            permissions,
          });
          didUpdate = true;
        }
        const nextOwner = owner && entry.owner !== owner ? owner : null;
        const nextGroup = group && entry.group !== group ? group : null;
        if (nextOwner || nextGroup) {
          await invoke("sftp_set_owner", {
            sessionId: session.id,
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
      handleOperationError(error);
    } finally {
      if (didUpdate) {
        await loadDirectory(session.id, browser.path);
      }
      setOperationLoading(false);
    }
  }

  async function sendFilesToAi(entries: SftpEntry[]) {
    if (!session || operationLoading) return;
    const files = entries.filter((entry) => entry.kind === "file");
    if (!files.length) return;
    if (files.length > MAX_AI_REMOTE_FILES) {
      Message.warning(`每次最多发送 ${MAX_AI_REMOTE_FILES} 个文件给 AI`);
      return;
    }
    const selectedBytes = files.reduce((total, entry) => total + entry.size, 0);
    if (selectedBytes > MAX_AI_REMOTE_FILES_BYTES) {
      Message.warning("所选文件总大小不能超过 512 KiB");
      return;
    }
    const invalidFile = files.find((entry) =>
      Boolean(aiRemoteFileContextError(entry.size)),
    );
    if (invalidFile) {
      Message.warning(
        `${invalidFile.name}：${aiRemoteFileContextError(invalidFile.size)}`,
      );
      return;
    }

    const targetSessionId = session.id;
    setOperationLoading(true);
    try {
      const contexts: AiRemoteFileContext[] = [];
      for (const entry of files) {
        const document = await invoke<RemoteTextFile>("sftp_read_text_file", {
          sessionId: targetSessionId,
          path: entry.path,
        });
        const documentSizeError = aiRemoteFileContextError(document.size);
        if (documentSizeError) {
          throw new Error(`${entry.name}：${documentSizeError}`);
        }
        contexts.push({
          content: document.content,
          name: entry.name,
          path: document.path,
          size: document.size,
        });
      }
      await onSendFilesToAi(targetSessionId, contexts);
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperationLoading(false);
    }
  }

  function entryContextMenuItems(entries: SftpEntry[]): ContextMenuItem[] {
    return buildSftpContextMenu({
      clipboardEntryCount: currentClipboard?.entries.length ?? 0,
      entries,
      externalEditorName,
      externalEditorPath,
      operationLoading,
      onArchive: openArchiveDialog,
      onChooseExternalEditor: chooseExternalEditor,
      onCopy: (selected) => storeClipboard(selected, "copy"),
      onCut: (selected) => storeClipboard(selected, "cut"),
      onDelete: requestDeleteEntries,
      onDownload: downloadEntry,
      onDownloadMany: downloadEntries,
      onEditText: openTextEditor,
      onExtract: extractRemoteArchive,
      onFastDelete: requestFastDelete,
      onOpenDirectory: openDirectory,
      onOpenExternal: openExternalEditor,
      onPaste: (targetDirectory) =>
        currentClipboard
          ? requestPaste(targetDirectory, currentClipboard)
          : undefined,
      onPermissions: openPermissionsDialog,
      onRefresh: () => {
        if (session && browser) {
          return loadDirectory(session.id, browser.path);
        }
      },
      onRename: openRenameDialog,
      onResolveExternalEdit: selectExternalEditConflict,
      onSendFilesToAi: sendFilesToAi,
      onSendSelectionToAi: (selected) => {
        if (!session || !browser) return;
        return onSendSelectionToAi(session.id, browser.path, selected);
      },
      resolveExternalEdit: externalEditForEntry,
      rootDirectory: browser?.path,
    });
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
    <section
      aria-label="文件管理"
      className="panel sftp-panel"
      onPointerDownCapture={focusFilePanelForShortcut}
      ref={panelRef}
      tabIndex={-1}
    >
      <SftpToolbar
        bookmarks={currentLocation.bookmarks}
        clipboardEntryCount={currentClipboard?.entries.length ?? 0}
        connected={Boolean(connected)}
        currentPath={browser?.path ?? "/"}
        currentPathBookmarked={currentPathBookmarked}
        history={currentLocation.history}
        inputPath={browser?.inputPath ?? "/"}
        loading={browser?.status === "loading"}
        onClearHistory={clearPathHistory}
        onCreate={openCreateDialog}
        onInputPathChange={(value) =>
          session && updateBrowser(session.id, { inputPath: value })
        }
        onNavigate={navigateToPath}
        onOpenTransfers={() => setTransferDrawerVisible(true)}
        onPaste={() => {
          if (browser && currentClipboard) {
            void requestPaste(browser.path, currentClipboard);
          }
        }}
        onRefresh={() => {
          if (session && browser) {
            void loadDirectory(session.id, browser.path);
          }
        }}
        onRemoveBookmark={removePathBookmark}
        onToggleBookmark={toggleCurrentPathBookmark}
        onUp={() => {
          if (session && browser) {
            void loadDirectory(session.id, remoteParentPath(browser.path));
          }
        }}
        onUpload={() => void chooseUploadFiles()}
        operationLoading={operationLoading}
        pathSuggestions={pathSuggestions}
        ready={ready}
        transferActivityCount={transferActivityCount}
      />

      {connected && browser?.status === "failed" ? (
        <div className="panel-empty">
          <div className="empty-action">
            <Empty description={browser.error || "SFTP 连接失败"} />
            <Button
              icon={<IconRefresh />}
              onClick={() => void retryConnection()}
            >
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
                <span>
                  释放以上传文件或文件夹到
                  {fileDropTargetPath
                    ? `“${localFileName(fileDropTargetPath)}”`
                    : `“${browser?.path ?? "/"}”`}
                </span>
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
                "data-sftp-entry-kind": entry.kind,
                "data-sftp-entry-path": entry.path,
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
              rowClassName={(entry) =>
                [
                  cutEntryPaths.has(entry.path) ? "sftp-row-cut" : "",
                  remoteDropTargetPath === entry.path
                    ? "sftp-row-drop-target"
                    : "",
                  fileDropTargetPath === entry.path
                    ? "sftp-row-drop-target"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
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
            {remoteDragPreview && (
              <div
                className="sftp-remote-drag-preview"
                style={{
                  left: remoteDragPreview.x + 12,
                  top: remoteDragPreview.y + 12,
                }}
              >
                {remoteDragPreview.kind === "directory" ? (
                  <IconFolder />
                ) : (
                  <IconFile />
                )}
                <span>{remoteDragPreview.label}</span>
                {remoteDragPreview.count > 1 && (
                  <span className="sftp-remote-drag-count">
                    {remoteDragPreview.count}
                  </span>
                )}
              </div>
            )}
          </div>
        </ContextMenu>
      )}
      <SftpTransferDrawer
        externalEdits={currentExternalEdits}
        onCancelTransfer={(transfer) => void cancelTransfer(transfer)}
        onClearFinished={clearFinishedTransfers}
        onClose={() => setTransferDrawerVisible(false)}
        onOpenExternalEdit={(edit) => void reopenExternalEditLocalFile(edit)}
        onPauseTransfer={(transfer) => void pauseTransfer(transfer)}
        onResolveExternalEdit={selectExternalEditConflict}
        onResumeTransfer={(transfer) => void resumeTransfer(transfer)}
        onRetryTransfer={(transfer) => void retryTransfer(transfer)}
        transfers={currentTransfers}
        visible={transferDrawerVisible}
      />
      <TextEditorDialog
        byteLength={textEditorByteLength}
        maxBytes={REMOTE_TEXT_MAX_BYTES}
        onCancel={requestCloseTextEditor}
        onChange={updateTextContent}
        onSave={() => void saveTextEditor()}
        state={textEditor}
      />
      <ExternalEditConflictDialog
        edit={externalEditConflict}
        loading={externalEditActionLoading}
        onCancel={() => selectExternalEditConflict(null)}
        onResolve={(action) => void resolveExternalEdit(action)}
      />
      <PasteConflictDialog
        conflictCount={pendingPaste?.conflictCount ?? 0}
        loading={operationLoading}
        onCancel={() => setPendingPaste(null)}
        onConfirm={() => {
          if (!pendingPaste) return;
          void pasteClipboard(
            pendingPaste.clipboard,
            pendingPaste.targetDirectory,
            pasteConflictPolicy,
          ).then(() => setPendingPaste(null));
        }}
        onPolicyChange={setPasteConflictPolicy}
        policy={pasteConflictPolicy}
        visible={Boolean(pendingPaste)}
      />
      <ArchiveDialog
        baseName={archiveBaseName}
        format={archiveFormat}
        loading={operationLoading}
        onBaseNameChange={setArchiveBaseName}
        onCancel={closeArchiveDialog}
        onConfirm={() => void submitArchiveDialog()}
        onFormatChange={setArchiveFormat}
        state={archiveDialog}
      />
      <CreateEntryDialog
        kind={creatingEntryKind}
        loading={operationLoading}
        name={newEntryName}
        onCancel={() => {
          setCreatingEntryKind(null);
          setNewEntryName("");
        }}
        onConfirm={() => void createEntry()}
        onNameChange={setNewEntryName}
      />
      <PermissionsDialog
        entries={permissionEntries}
        group={permissionGroup}
        loading={operationLoading}
        onCancel={() => {
          setPermissionEntries([]);
          setPermissionValue("");
          setPermissionOwner("");
          setPermissionGroup("");
        }}
        onConfirm={() => void updatePermissions()}
        onGroupChange={setPermissionGroup}
        onOwnerChange={setPermissionOwner}
        onPermissionChange={setPermissionValue}
        owner={permissionOwner}
        parsedPermission={parsedPermissionValue}
        permission={permissionValue}
      />
      <RenameDialog
        entry={renamingEntry}
        loading={operationLoading}
        name={renameName}
        onCancel={() => {
          setRenamingEntry(null);
          setRenameName("");
        }}
        onConfirm={() => void renameEntry()}
        onNameChange={setRenameName}
      />
    </section>
  );
}

export default SftpPanel;
