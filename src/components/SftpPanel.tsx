import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Input,
  Message,
  Modal,
  Popconfirm,
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
import { Sticky, StickyContainer } from "react-sticky";
import {
  IconArrowUp,
  IconDelete,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderAdd,
  IconHistory,
  IconRefresh,
  IconUpload,
} from "@arco-design/web-react/icon";
import type {
  SftpConnectResult,
  SftpEntry,
  SftpListResult,
  TerminalSession,
} from "../models";
import {
  formatFileSize,
  formatPermissions,
  formatRemoteTime,
  isValidRemoteName,
  localFileName,
  remoteJoinPath,
  remoteParentPath,
} from "../sftp-utils";

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
}

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

function SftpStickyHeader({
  children,
  className,
  style: headerStyle,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <Sticky relative>
      {({ isSticky, style }) => (
        <div
          {...props}
          className={[
            className,
            "sftp-sticky-header",
            isSticky ? "sftp-sticky-header-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ ...headerStyle, ...style }}
        >
          {children}
        </div>
      )}
    </Sticky>
  );
}

const SFTP_TABLE_COMPONENTS = {
  header: {
    wrapper: SftpStickyHeader,
  },
};

function createTransferId() {
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const [newDirectoryVisible, setNewDirectoryVisible] = useState(false);
  const [newDirectoryName, setNewDirectoryName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [operationLoading, setOperationLoading] = useState(false);
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
              hostId: currentSession.host.id,
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
        return {
          ...current,
          [payload.transferId]: {
            ...previous,
            ...payload,
            transferredBytes:
              payload.status === "failed" && payload.transferredBytes === 0
                ? previous.transferredBytes
                : payload.transferredBytes,
            totalBytes: payload.totalBytes || previous.totalBytes,
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
      {
        title: "操作",
        width: 126,
        render: (_, entry) => (
          <Space size="mini">
            {entry.kind !== "directory" && (
              <Tooltip content="下载">
                <Button
                  aria-label={`下载 ${entry.name}`}
                  disabled={!ready}
                  icon={<IconDownload />}
                  onClick={() => void downloadEntry(entry)}
                  size="mini"
                />
              </Tooltip>
            )}
            <Tooltip content="重命名">
              <Button
                aria-label={`重命名 ${entry.name}`}
                disabled={!ready}
                icon={<IconEdit />}
                onClick={() => openRenameDialog(entry)}
                size="mini"
              />
            </Tooltip>
            {confirmFileDelete ? (
              <Popconfirm
                content={`删除“${entry.name}”？${entry.kind === "directory" ? "目录必须为空。" : ""}`}
                onOk={() => deleteEntry(entry)}
              >
                <Tooltip content="删除">
                  <Button
                    aria-label={`删除 ${entry.name}`}
                    disabled={!ready}
                    icon={<IconDelete />}
                    size="mini"
                    status="danger"
                  />
                </Tooltip>
              </Popconfirm>
            ) : (
              <Tooltip content="删除">
                <Button
                  aria-label={`删除 ${entry.name}`}
                  disabled={!ready}
                  icon={<IconDelete />}
                  onClick={() => void deleteEntry(entry).catch(() => undefined)}
                  size="mini"
                  status="danger"
                />
              </Tooltip>
            )}
          </Space>
        ),
      },
    ],
    [browser, confirmFileDelete, ready, session],
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

  async function createDirectory() {
    if (!session || !browser) return;
    const name = newDirectoryName.trim();
    if (!isValidRemoteName(name)) {
      Message.warning("目录名称不能为空，且不能包含路径分隔符");
      return;
    }

    setOperationLoading(true);
    try {
      await invoke("sftp_create_directory", {
        sessionId: session.id,
        path: remoteJoinPath(browser.path, name),
      });
      setNewDirectoryVisible(false);
      setNewDirectoryName("");
      Message.success(`已新建目录 ${name}`);
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

  async function deleteEntry(entry: SftpEntry) {
    if (!session || !browser) return;
    try {
      await invoke("sftp_delete", {
        sessionId: session.id,
        path: entry.path,
      });
      Message.success(`已删除 ${entry.name}`);
      await loadDirectory(session.id, browser.path);
    } catch (error) {
      handleOperationError(error);
      throw error;
    }
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
          <Button
            disabled={!ready}
            icon={<IconFolderAdd />}
            onClick={() => setNewDirectoryVisible(true)}
            size="mini"
          >
            新建目录
          </Button>
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
        <StickyContainer className="sftp-table-container">
          <Table
            border={false}
            className="sftp-table"
            columns={columns}
            components={SFTP_TABLE_COMPONENTS}
            data={ready ? visibleEntries : []}
            loading={Boolean(connected && busy)}
            noDataElement={
              <Empty description={ready ? "目录为空" : "暂无文件"} />
            }
            onRow={(entry) => ({
              onDoubleClick: () => openDirectory(entry),
            })}
            pagination={false}
            rowKey="id"
            scroll={{ y: true }}
            size="small"
          />
        </StickyContainer>
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
              const statusText =
                transfer.status === "completed"
                  ? "已完成"
                  : transfer.status === "failed"
                    ? "传输失败"
                    : transfer.totalBytes > 0
                      ? `${formatFileSize(transfer.transferredBytes)} / ${formatFileSize(transfer.totalBytes)}`
                      : "正在传输";

              return (
                <div className="sftp-transfer-row" key={transfer.transferId}>
                  <span className="sftp-transfer-direction">
                    {transfer.direction === "upload" ? (
                      <IconUpload />
                    ) : (
                      <IconDownload />
                    )}
                  </span>
                  <div className="sftp-transfer-content">
                    <div className="sftp-transfer-meta">
                      <Typography.Text ellipsis>
                        {transfer.fileName}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {statusText}
                      </Typography.Text>
                    </div>
                    <Progress
                      percent={percent}
                      showText
                      size="small"
                      status={
                        transfer.status === "failed" ? "error" : "normal"
                      }
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
          setNewDirectoryVisible(false);
          setNewDirectoryName("");
        }}
        onOk={() => void createDirectory()}
        title="新建目录"
        visible={newDirectoryVisible}
      >
        <Input
          autoFocus
          onChange={setNewDirectoryName}
          onPressEnter={() => void createDirectory()}
          placeholder="目录名称"
          value={newDirectoryName}
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
