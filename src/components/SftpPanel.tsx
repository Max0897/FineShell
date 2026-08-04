import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Empty,
  Message,
  Modal,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  IconExclamationCircle,
  IconFile,
  IconFolder,
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
  invertSftpEntryKeys,
  localFileName,
  matchRemoteDirectoryPaths,
  remoteParentPath,
  selectAllSftpEntryKeys,
  setRemotePathBookmark,
} from "../sftp-utils";
import {
  isTerminalSessionOperational,
  jumpHostRequest,
  sshCredentialId,
} from "../terminal-utils";
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
  type RemoteTextFile,
} from "./sftp/SftpDialogs";
import SftpTransferDrawer from "./sftp/SftpTransferDrawer";
import ConnectionStatusOverlay from "./ConnectionStatusOverlay";
import buildSftpContextMenu from "./sftp/buildSftpContextMenu";
import SftpToolbar from "./sftp/SftpToolbar";
import useSftpArchives from "./sftp/useSftpArchives";
import useSftpClipboard from "./sftp/useSftpClipboard";
import useSftpEntryOperations from "./sftp/useSftpEntryOperations";
import useSftpFileTransfers from "./sftp/useSftpFileTransfers";
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
  onCurrentPathChange: (sessionId: string | null, path: string) => void;
  onReconnect: () => void;
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

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

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
  onReconnect,
  onSendFilesToAi,
  onSendSelectionToAi,
  refreshRequest,
  session,
  showHiddenFiles,
  terminalDirectory,
}: SftpPanelProps) {
  const [browsers, setBrowsers] = useState<Record<string, BrowserState>>({});
  const [transferDrawerVisible, setTransferDrawerVisible] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const [retryingSessionId, setRetryingSessionId] = useState<string>();
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
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
  const {
    clearClipboard,
    currentClipboard,
    cutEntryPaths,
    pasteClipboard,
    pasteConflictPolicy,
    pendingPaste,
    requestPaste,
    selectPasteConflictPolicy,
    setPendingPaste,
    storeClipboard,
  } = useSftpClipboard({
    onClearSelection: () => setSelectedEntryKeys([]),
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onRefreshDirectory: async () => {
      if (!session) return;
      const currentBrowser = browsersRef.current[session.id];
      if (currentBrowser) {
        await loadDirectory(session.id, currentBrowser.path);
      }
    },
    sessionId: session?.id,
  });

  useEffect(() => {
    if (!session) return;

    if (isTerminalSessionOperational(session.status)) {
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
      clearClipboard(session.id);
    }
  }, [
    browsers,
    cancelSessionTransfers,
    clearClipboard,
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
  const connected = Boolean(
    session && isTerminalSessionOperational(session.status),
  );
  const ready = Boolean(connected && browser?.status === "ready");
  const busy =
    browser?.status === "connecting" || browser?.status === "loading";
  const sftpReconnecting = retryingSessionId === session?.id;
  const reconnecting = session?.status === "reconnecting" || sftpReconnecting;
  const sessionUnavailable = Boolean(
    session &&
      (session.status === "failed" ||
        session.status === "disconnected" ||
        reconnecting),
  );
  const sftpUnavailable = Boolean(connected && browser?.status === "failed");
  const connectionUnavailable = sessionUnavailable || sftpUnavailable;
  const connectionDescription = sftpReconnecting
    ? "正在重新连接 SFTP"
    : reconnecting
      ? "正在重新连接服务器"
      : sftpUnavailable
        ? browser?.error || "SFTP 连接失败"
        : session?.error || "服务器连接已断开";
  const {
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
  } = useSftpEntryOperations({
    confirmFileDelete,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: () => setSelectedEntryKeys([]),
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onRefreshDirectory: () => {
      if (session && browser) {
        return loadDirectory(session.id, browser.path);
      }
    },
    sessionId: session?.id,
  });
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

  const {
    archiveBaseName,
    archiveDialog,
    archiveFormat,
    closeArchiveDialog,
    extractRemoteArchive,
    openArchiveDialog,
    setArchiveBaseName,
    setArchiveFormat,
    submitArchiveDialog,
  } = useSftpArchives({
    confirmOverwrite: confirmBatchOverwrite,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: () => setSelectedEntryKeys([]),
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onQueueDownload: ({ archiveName, format, localPath, sourcePaths }) => {
      if (!session) return;
      queueArchiveDownload({
        archiveName,
        format,
        localPath,
        sessionId: session.id,
        sourcePaths,
      });
    },
    onRefreshDirectory: () => {
      if (session && browser) {
        return loadDirectory(session.id, browser.path);
      }
    },
    sessionId: session?.id,
  });
  const {
    chooseUploadFiles,
    downloadEntries,
    downloadEntry,
    dropZoneRef,
    fileDropActive,
    fileDropTargetPath,
  } = useSftpFileTransfers({
    confirmOverwrite: confirmBatchOverwrite,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: () => setSelectedEntryKeys([]),
    onQueueTransfer: queueTransfer,
    onRefreshDirectory: () => {
      if (session && browser) {
        return loadDirectory(session.id, browser.path);
      }
    },
    ready,
    sessionId: session?.id,
  });

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
    setRetryingSessionId(session.id);
    try {
      connectedHomesRef.current.delete(session.id);
      await invoke("sftp_disconnect", { sessionId: session.id }).catch(
        () => undefined,
      );
      updateBrowser(session.id, { status: "idle", error: undefined });
      await connectAndLoad(session);
    } finally {
      setRetryingSessionId((current) =>
        current === session.id ? undefined : current,
      );
    }
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

      <>
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
            {connectionUnavailable && (
              <ConnectionStatusOverlay
                description={connectionDescription}
                onReconnect={
                  sftpUnavailable ? () => void retryConnection() : onReconnect
                }
                reconnecting={reconnecting}
              />
            )}
          </div>
        </ContextMenu>
      </>
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
        onPolicyChange={selectPasteConflictPolicy}
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
        onCancel={closeCreateDialog}
        onConfirm={() => void createEntry()}
        onNameChange={setNewEntryName}
      />
      <PermissionsDialog
        entries={permissionEntries}
        group={permissionGroup}
        loading={operationLoading}
        onCancel={closePermissionsDialog}
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
        onCancel={closeRenameDialog}
        onConfirm={() => void renameEntry()}
        onNameChange={setRenameName}
      />
    </section>
  );
}

export default SftpPanel;
