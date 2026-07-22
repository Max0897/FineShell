import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Empty,
  Input,
  Message,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  IconArrowUp,
  IconFile,
  IconFolder,
  IconFolderAdd,
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
  session: TerminalSession | null;
}

const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

function SftpPanel({ session }: SftpPanelProps) {
  const [browsers, setBrowsers] = useState<Record<string, BrowserState>>({});
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
              connectTimeoutSeconds:
                currentSession.host.connectTimeoutSeconds,
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

  const browser = session ? browsers[session.id] ?? INITIAL_BROWSER : null;
  const ready = Boolean(session && browser?.status === "ready");
  const busy =
    browser?.status === "connecting" || browser?.status === "loading";

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
          value={
            session
              ? browser?.inputPath ?? "/"
              : "未连接"
          }
        />
        <Space size="mini">
          <Button disabled icon={<IconFolderAdd />} size="mini">
            新建目录
          </Button>
          <Button disabled icon={<IconUpload />} size="mini" type="primary">
            上传
          </Button>
        </Space>
      </div>
      {!session ? (
        <div className="panel-empty">
          <Empty description="SFTP 未连接" />
        </div>
      ) : session.status !== "connected" ? (
        <div className="panel-empty">
          <Empty description="等待 SSH 连接" />
        </div>
      ) : browser?.status === "failed" ? (
        <div className="panel-empty">
          <div className="empty-action">
            <Empty description={browser.error || "SFTP 连接失败"} />
            <Button icon={<IconRefresh />} onClick={() => void retryConnection()}>
              重试
            </Button>
          </div>
        </div>
      ) : (
        <Table
          border={false}
          className="sftp-table"
          columns={columns}
          data={browser?.entries ?? []}
          loading={busy}
          noDataElement={<Empty description="目录为空" />}
          onRow={(entry) => ({
            onDoubleClick: () => openDirectory(entry),
          })}
          pagination={false}
          rowKey="id"
          size="small"
        />
      )}
    </section>
  );
}

export default SftpPanel;
