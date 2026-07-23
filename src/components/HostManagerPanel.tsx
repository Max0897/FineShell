import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Message,
  Menu,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  IconDelete,
  IconCopy,
  IconEdit,
  IconFolder,
  IconHistory,
  IconLink,
  IconMore,
  IconPlus,
  IconSort,
} from "@arco-design/web-react/icon";
import type {
  ConnectionHistoryRecord,
  HostFormValues,
  HostAuthMethod,
  HostRecord,
  HostSortMode,
  JumpHostConnection,
  QuickTarget,
  ProxyRecord,
} from "../models";
import HostEditorModal from "./HostEditorModal";
import {
  jumpHostSelectionError,
  normalizeHostForm,
} from "../host-storage";
import {
  buildHostTableTree,
  createHostCopy,
  sortHosts,
  type HostTableRow,
} from "../host-organization";
import {
  loadConfiguration,
  moveHostToTrash,
  purgeExpiredDeletedHosts,
  replaceConfigurationContent,
  updateHostSortMode,
} from "../config-database";
import type { AppSettings } from "../app-settings";

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function storeHostPassword(hostId: string, password: string) {
  if (!isTauri()) return;
  await invoke("store_host_password", { hostId, password });
}

async function removeHostPassword(hostId: string) {
  if (!isTauri()) return;
  await invoke("delete_host_password", { hostId });
}

async function storePrivateKeyPassphrase(hostId: string, passphrase: string) {
  if (!isTauri()) return;
  await invoke("store_private_key_passphrase", { hostId, passphrase });
}

async function removePrivateKeyPassphrase(hostId: string) {
  if (!isTauri()) return;
  await invoke("delete_private_key_passphrase", { hostId });
}

async function choosePrivateKeyPath() {
  if (!isTauri()) return undefined;
  const selected = await open({
    directory: false,
    multiple: false,
    title: "选择 SSH 私钥",
  });
  return typeof selected === "string" ? selected : undefined;
}

function targetKey(
  target: Pick<
    HostRecord,
    "address" | "port" | "username" | "proxyId" | "jumpHostId"
  >,
) {
  return `${target.username}@${target.address}:${target.port}#${target.proxyId ?? "direct"}#${target.jumpHostId ?? "no-jump"}`;
}

function formatTime(value?: string) {
  if (!value) return "从未连接";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

interface HostManagerPanelProps {
  onConnect: (
    host: HostRecord,
    proxy?: ProxyRecord,
    jumpHost?: JumpHostConnection,
  ) => void;
  settings: AppSettings;
}

function HostManagerPanel({ onConnect, settings }: HostManagerPanelProps) {
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [history, setHistory] = useState<ConnectionHistoryRecord[]>([]);
  const [proxies, setProxies] = useState<ProxyRecord[]>([]);
  const [hostSort, setHostSort] = useState<HostSortMode>("manual");
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [configurationAction, setConfigurationAction] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingHost, setEditingHost] = useState<HostRecord | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [quickTarget, setQuickTarget] = useState<QuickTarget>({
    address: "",
    port: 22,
    username: "root",
  });
  const [quickPassword, setQuickPassword] = useState("");
  const [quickAuthMethod, setQuickAuthMethod] =
    useState<HostAuthMethod>("password");
  const [quickPrivateKeyPath, setQuickPrivateKeyPath] = useState("");
  const [quickPrivateKeyPassphrase, setQuickPrivateKeyPassphrase] =
    useState("");
  const [quickProxyId, setQuickProxyId] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void purgeExpiredDeletedHosts()
      .then(async ({ configuration, expiredHostIds }) => {
        if (disposed) return;
        setHosts(configuration.hosts);
        setHistory(configuration.history);
        setProxies(configuration.proxies);
        setHostSort(configuration.hostSort);

        const cleanup = await Promise.allSettled(
          expiredHostIds.flatMap((hostId) => [
            removeHostPassword(hostId),
            removePrivateKeyPassphrase(hostId),
          ]),
        );
        if (
          !disposed &&
          cleanup.some((result) => result.status === "rejected")
        ) {
          Message.warning("过期主机已清理，但部分系统凭据删除失败");
        }
      })
      .catch(() => {
        if (!disposed) Message.error("本地配置读取失败");
      })
      .finally(() => {
        if (!disposed) setConfigurationLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("configuration:changed", () => {
      void loadConfiguration()
        .then((configuration) => {
          if (disposed) return;
          setHosts(configuration.hosts);
          setHistory(configuration.history);
          setProxies(configuration.proxies);
          setHostSort(configuration.hostSort);
        })
        .catch((error) => {
          if (!disposed) Message.error(String(error));
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

  const filteredHosts = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return hosts;

    return hosts.filter((host) =>
      [host.name, host.address, host.username, host.group]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized)),
    );
  }, [hosts, keyword]);
  const visibleHosts = useMemo(
    () => sortHosts(filteredHosts, hostSort),
    [filteredHosts, hostSort],
  );
  const hostTableRows = useMemo(
    () => buildHostTableTree(visibleHosts),
    [visibleHosts],
  );

  function openHostEditor(host: HostRecord | null) {
    setEditingHost(host);
    setEditorVisible(true);
  }

  async function changeHostSort(nextSort: HostSortMode) {
    const previousSort = hostSort;
    setHostSort(nextSort);
    setConfigurationAction(true);
    try {
      const next = await updateHostSortMode(nextSort);
      setHostSort(next.hostSort);
    } catch (error) {
      setHostSort(previousSort);
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function saveHost(values: HostFormValues) {
    const {
      password,
      privateKeyPassphrase,
      host: normalized,
    } = normalizeHostForm(values);
    const hostId = editingHost?.id ?? createId("host");
    if (normalized.proxyId && normalized.jumpHostId) {
      Message.error("代理和跳板机不能同时配置");
      return;
    }
    const routeError = jumpHostSelectionError(
      hostId,
      normalized.jumpHostId,
      hosts,
    );
    if (routeError) {
      Message.error(routeError);
      return;
    }

    try {
      if (password) await storeHostPassword(hostId, password);
      if (privateKeyPassphrase) {
        await storePrivateKeyPassphrase(hostId, privateKeyPassphrase);
      }
    } catch {
      Message.error("认证凭据保存失败，请检查系统凭据库权限");
      return;
    }

    const nextHosts = editingHost
      ? hosts.map((host) =>
          host.id === editingHost.id ? { ...host, ...normalized } : host,
        )
      : [...hosts, { id: hostId, ...normalized }];
    try {
      await replaceConfigurationContent(nextHosts, history);
      setHosts(nextHosts);
    } catch {
      Message.error("主机配置保存失败");
      return;
    }

    Message.success(editingHost ? "主机信息已更新" : "主机已添加");

    setEditorVisible(false);
    setEditingHost(null);
  }

  async function deleteHost(host: HostRecord) {
    setConfigurationAction(true);
    try {
      const next = await moveHostToTrash(host.id);
      setHosts(next.hosts);
      if (isTauri()) {
        await emitTo("settings", "configuration:changed").catch(
          () => undefined,
        );
      }
      Message.success(`已将 ${host.name} 移至回收站`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function copyHost(host: HostRecord) {
    const copiedHost = createHostCopy(host, hosts, createId("host"));
    let credentialsCopied = false;
    setConfigurationAction(true);
    try {
      if (isTauri()) {
        await invoke("copy_host_credentials", {
          sourceHostId: host.id,
          targetHostId: copiedHost.id,
        });
        credentialsCopied = true;
      }

      const nextHosts = [...hosts, copiedHost];
      await replaceConfigurationContent(nextHosts, history);
      setHosts(nextHosts);
      Message.success(`已复制为 ${copiedHost.name}`);
    } catch (error) {
      if (credentialsCopied) {
        await Promise.allSettled([
          removeHostPassword(copiedHost.id),
          removePrivateKeyPassphrase(copiedHost.id),
        ]);
      }
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function sendConnection(host: HostRecord) {
    const proxy = host.proxyId
      ? proxies.find((item) => item.id === host.proxyId)
      : undefined;
    if (host.proxyId && !proxy) {
      Message.error("主机引用的代理不存在，请重新编辑主机");
      return;
    }
    const jumpHost = host.jumpHostId
      ? hosts.find((item) => item.id === host.jumpHostId)
      : undefined;
    if (host.jumpHostId && !jumpHost) {
      Message.error("主机引用的跳板机不存在，请重新编辑主机");
      return;
    }
    if (jumpHost?.jumpHostId) {
      Message.error("当前仅支持一级跳板机连接");
      return;
    }
    if (jumpHost && !jumpHost.hostFingerprint) {
      Message.error("请先直接连接并信任该跳板机，再将其用于连接链路");
      return;
    }
    const jumpProxy = jumpHost?.proxyId
      ? proxies.find((item) => item.id === jumpHost.proxyId)
      : undefined;
    if (jumpHost?.proxyId && !jumpProxy) {
      Message.error("跳板机引用的代理不存在，请重新编辑跳板机");
      return;
    }
    const now = new Date().toISOString();
    const identity = targetKey(host);
    const connectedHost = { ...host, lastConnectedAt: now };
    const historyRecord: ConnectionHistoryRecord = {
      id: createId("history"),
      hostId: host.id.startsWith("quick-") ? undefined : host.id,
      name: host.name,
      address: host.address,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      privateKeyPath: host.privateKeyPath,
      hostFingerprint: host.hostFingerprint,
      keepAliveIntervalSeconds: host.keepAliveIntervalSeconds,
      autoReconnect: host.autoReconnect,
      maxReconnectAttempts: host.maxReconnectAttempts,
      proxyId: host.proxyId,
      jumpHostId: host.jumpHostId,
      connectedAt: now,
    };

    const nextHosts = hosts.map((item) =>
      item.id === host.id ? connectedHost : item,
    );
    const nextHistory = [
      historyRecord,
      ...history.filter((item) => targetKey(item) !== identity),
    ].slice(0, 50);
    try {
      await replaceConfigurationContent(nextHosts, nextHistory);
      setHosts(nextHosts);
      setHistory(nextHistory);
    } catch {
      Message.warning("连接记录保存失败，本次连接仍将继续");
    }

    setHistoryVisible(false);
    onConnect(
      connectedHost,
      proxy,
      jumpHost ? { host: jumpHost, proxy: jumpProxy } : undefined,
    );
  }

  async function quickConnect() {
    const credentialReady =
      quickAuthMethod === "password"
        ? Boolean(quickPassword)
        : Boolean(quickPrivateKeyPath.trim());
    if (!quickTarget.address.trim() || !credentialReady) return;

    const normalized = {
      ...quickTarget,
      address: quickTarget.address.trim(),
      username: quickTarget.username.trim() || "root",
    };
    const host: HostRecord = {
      id: `quick-${targetKey({ ...normalized, proxyId: quickProxyId })}`,
      name: normalized.address,
      authMethod: quickAuthMethod,
      privateKeyPath:
        quickAuthMethod === "privateKey"
          ? quickPrivateKeyPath.trim()
          : undefined,
      connectTimeoutSeconds: settings.defaultConnectTimeoutSeconds,
      keepAliveIntervalSeconds: settings.defaultKeepAliveIntervalSeconds,
      autoReconnect: settings.defaultAutoReconnect,
      maxReconnectAttempts: settings.defaultMaxReconnectAttempts,
      proxyId: quickProxyId,
      ...normalized,
    };

    try {
      if (quickAuthMethod === "password") {
        await storeHostPassword(host.id, quickPassword);
      } else if (quickPrivateKeyPassphrase) {
        await storePrivateKeyPassphrase(host.id, quickPrivateKeyPassphrase);
      } else {
        await removePrivateKeyPassphrase(host.id);
      }
      setQuickPassword("");
      setQuickPrivateKeyPassphrase("");
      await sendConnection(host);
    } catch {
      Message.error("认证凭据保存失败，请检查系统凭据库权限");
    }
  }

  function reconnectFromHistory(record: ConnectionHistoryRecord) {
    const savedHost = hosts.find((host) => host.id === record.hostId);
    void sendConnection(
      savedHost ?? {
        id: `quick-${targetKey(record)}`,
        name: record.name,
        address: record.address,
        port: record.port,
        username: record.username,
        authMethod: record.authMethod ?? "password",
        privateKeyPath: record.privateKeyPath,
        hostFingerprint: record.hostFingerprint,
        connectTimeoutSeconds: settings.defaultConnectTimeoutSeconds,
        keepAliveIntervalSeconds:
          record.keepAliveIntervalSeconds ??
          settings.defaultKeepAliveIntervalSeconds,
        autoReconnect: record.autoReconnect ?? settings.defaultAutoReconnect,
        maxReconnectAttempts:
          record.maxReconnectAttempts ?? settings.defaultMaxReconnectAttempts,
        proxyId: record.proxyId,
        jumpHostId: record.jumpHostId,
      },
    );
  }

  const hostColumns: TableColumnProps<HostTableRow>[] = [
    {
      title: "主机",
      dataIndex: "name",
      render: (_, row) =>
        row.type === "group" ? (
          <div className="host-table-group-cell">
            <IconFolder />
            <Typography.Text bold>{row.name}</Typography.Text>
            <Typography.Text type="secondary">{row.count} 台</Typography.Text>
          </div>
        ) : (
          <div className="host-name-cell">
            <Typography.Text bold>{row.host.name}</Typography.Text>
            <Typography.Text type="secondary">
              {row.host.username}@{row.host.address}:{row.host.port}
            </Typography.Text>
          </div>
        ),
    },
    {
      title: "最近连接",
      width: 150,
      render: (_, row) =>
        row.type === "host" ? formatTime(row.host.lastConnectedAt) : null,
    },
    {
      title: "操作",
      width: 140,
      render: (_, row) =>
        row.type === "host" ? (
          <Space size="mini">
            <Button
              disabled={configurationAction}
              icon={<IconLink />}
              onClick={() => void sendConnection(row.host)}
              size="mini"
              type="primary"
            >
              连接
            </Button>
            <Dropdown
              disabled={configurationAction}
              droplist={
                <Menu
                  className="host-more-menu"
                  onClickMenuItem={(key) => {
                    if (key === "edit") {
                      openHostEditor(row.host);
                    } else if (key === "copy") {
                      void copyHost(row.host);
                    } else if (key === "delete") {
                      Modal.confirm({
                        cancelText: "取消",
                        content: `删除后可在设置的回收站中恢复“${row.host.name}”。`,
                        okButtonProps: { status: "danger" },
                        okText: "删除",
                        onOk: () => deleteHost(row.host),
                        title: "删除主机？",
                      });
                    }
                  }}
                >
                  <Menu.Item key="edit">
                    <span className="host-more-menu-label">
                      <IconEdit />
                      编辑
                    </span>
                  </Menu.Item>
                  <Menu.Item key="copy">
                    <span className="host-more-menu-label">
                      <IconCopy />
                      复制
                    </span>
                  </Menu.Item>
                  <Menu.Item className="host-more-delete" key="delete">
                    <span className="host-more-menu-label">
                      <IconDelete />
                      删除
                    </span>
                  </Menu.Item>
                </Menu>
              }
              position="br"
              trigger="click"
            >
              <Tooltip content="更多操作">
                <Button
                  aria-label={`更多 ${row.host.name} 操作`}
                  icon={<IconMore />}
                  size="mini"
                />
              </Tooltip>
            </Dropdown>
          </Space>
        ) : null,
    },
  ];

  const historyColumns: TableColumnProps<ConnectionHistoryRecord>[] = [
    {
      title: "连接目标",
      dataIndex: "name",
      render: (_, record) => (
        <div className="host-name-cell">
          <Typography.Text bold>{record.name}</Typography.Text>
          <Typography.Text type="secondary">
            {record.username}@{record.address}:{record.port}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "连接时间",
      dataIndex: "connectedAt",
      width: 160,
      render: (value) => formatTime(value),
    },
    {
      title: "操作",
      width: 100,
      render: (_, record) => (
        <Button
          disabled={configurationAction}
          icon={<IconLink />}
          onClick={() => reconnectFromHistory(record)}
          size="mini"
          type="primary"
        >
          重连
        </Button>
      ),
    },
  ];

  return (
    <main className="host-manager-panel">
      <section className="manager-pane hosts-manager-content">
        <div className="manager-toolbar">
          <div className="manager-toolbar-filters">
            <Input.Search
              allowClear
              onChange={setKeyword}
              placeholder="搜索名称、地址或分组"
              value={keyword}
            />
            <div className="host-sort-control">
              <IconSort />
              <Select
                aria-label="主机排序方式"
                disabled={configurationLoading || configurationAction}
                onChange={(value) => void changeHostSort(value as HostSortMode)}
                options={[
                  { label: "添加顺序", value: "manual" },
                  { label: "名称升序", value: "nameAsc" },
                  { label: "名称降序", value: "nameDesc" },
                  { label: "地址升序", value: "addressAsc" },
                  { label: "最近连接", value: "recentDesc" },
                ]}
                value={hostSort}
              />
            </div>
          </div>
          <div className="manager-toolbar-actions">
            <Button
              disabled={configurationLoading || configurationAction}
              icon={<IconPlus />}
              onClick={() => openHostEditor(null)}
              type="primary"
            >
              新增主机
            </Button>
            <Tooltip content="连接历史">
              <Button
                aria-label="打开连接历史"
                icon={<IconHistory />}
                onClick={() => setHistoryVisible(true)}
              />
            </Tooltip>
          </div>
        </div>
        <Table
          border={false}
          className="host-tree-table"
          columns={hostColumns}
          data={hostTableRows}
          defaultExpandAllRows
          expandProps={{ expandRowByClick: true }}
          indentSize={20}
          loading={configurationLoading}
          noDataElement={
            <Empty description={keyword ? "没有匹配的主机" : "暂无主机"} />
          }
          pagination={false}
          rowClassName={(row) =>
            row.type === "group" ? "host-table-group-row" : ""
          }
          rowKey="id"
          size="small"
        />
      </section>

      <Modal
        className="connection-history-modal"
        footer={null}
        onCancel={() => setHistoryVisible(false)}
        title="连接历史"
        visible={historyVisible}
      >
        <div className="connection-history-content">
          <div className="quick-connect">
            <Typography.Text bold>快速连接</Typography.Text>
            <div className="quick-connect-fields">
              <Input
                onChange={(address) =>
                  setQuickTarget((current) => ({ ...current, address }))
                }
                placeholder="主机地址"
                value={quickTarget.address}
              />
              <Input
                onChange={(username) =>
                  setQuickTarget((current) => ({ ...current, username }))
                }
                placeholder="用户名"
                value={quickTarget.username}
              />
              <Select
                onChange={setQuickAuthMethod}
                options={[
                  { label: "密码认证", value: "password" },
                  { label: "私钥认证", value: "privateKey" },
                ]}
                value={quickAuthMethod}
              />
              {quickAuthMethod === "password" ? (
                <Input.Password
                  onChange={setQuickPassword}
                  placeholder="密码"
                  value={quickPassword}
                />
              ) : (
                <div className="quick-key-credentials">
                  <Input.Search
                    onChange={setQuickPrivateKeyPath}
                    onSearch={() =>
                      void choosePrivateKeyPath().then((path) => {
                        if (path) setQuickPrivateKeyPath(path);
                      })
                    }
                    placeholder="私钥文件"
                    searchButton={
                      <Tooltip content="选择私钥文件">
                        <IconFolder />
                      </Tooltip>
                    }
                    value={quickPrivateKeyPath}
                  />
                  <Input.Password
                    onChange={setQuickPrivateKeyPassphrase}
                    placeholder="私钥口令（可选）"
                    value={quickPrivateKeyPassphrase}
                  />
                </div>
              )}
              <InputNumber
                max={65535}
                min={1}
                onChange={(port) =>
                  setQuickTarget((current) => ({ ...current, port }))
                }
                placeholder="端口"
                value={quickTarget.port}
              />
              <Select
                allowClear
                onChange={setQuickProxyId}
                options={proxies.map((proxy) => ({
                  label: proxy.name,
                  value: proxy.id,
                }))}
                placeholder="直连"
                value={quickProxyId}
              />
              <Button
                disabled={
                  configurationLoading ||
                  configurationAction ||
                  !quickTarget.address.trim() ||
                  (quickAuthMethod === "password"
                    ? !quickPassword
                    : !quickPrivateKeyPath.trim())
                }
                icon={<IconLink />}
                onClick={() => void quickConnect()}
                type="primary"
              >
                连接
              </Button>
            </div>
          </div>
          <div className="history-heading">
            <Typography.Text bold>最近连接</Typography.Text>
          </div>
          <Table
            border={false}
            columns={historyColumns}
            data={history}
            loading={configurationLoading}
            noDataElement={<Empty description="暂无连接历史" />}
            pagination={false}
            rowKey="id"
            size="small"
          />
        </div>
      </Modal>

      {editorVisible && (
        <HostEditorModal
          connectionDefaults={settings}
          host={editingHost}
          hosts={hosts}
          proxies={proxies}
          onCancel={() => {
            setEditorVisible(false);
            setEditingHost(null);
          }}
          onChoosePrivateKey={choosePrivateKeyPath}
          onSubmit={saveHost}
          visible
        />
      )}
    </main>
  );
}

export default HostManagerPanel;
