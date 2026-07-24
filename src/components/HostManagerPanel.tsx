import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  Message,
  Modal,
  Select,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  emitProtocolEventTo,
  listenProtocolEvent,
} from "../tauri-protocol";
import {
  IconFolder,
  IconHistory,
  IconLink,
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
  SshKeyRecord,
} from "../models";
import HostEditorModal from "./HostEditorModal";
import HostActions from "./HostActions";
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
  removeCredentialReference,
  replaceConfigurationContent,
  upsertCredentialReference,
  updateHostSortMode,
} from "../config-database";
import type { AppSettings } from "../app-settings";
import { applyConnectionHistoryPolicy } from "../connection-history";
import {
  connectionTargetKey,
  createCredentialReference,
} from "../credential-registry";

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function storeHostPassword(hostId: string, password: string) {
  if (!isTauri()) return;
  await invoke("store_host_password", { hostId, password });
}

async function removeHostPassword(hostId: string) {
  if (isTauri()) await invoke("delete_host_password", { hostId });
  await removeCredentialReference("hostPassword", hostId);
}

async function storePrivateKeyPassphrase(hostId: string, passphrase: string) {
  if (!isTauri()) return;
  await invoke("store_private_key_passphrase", { hostId, passphrase });
}

async function removePrivateKeyPassphrase(hostId: string) {
  if (isTauri()) {
    await invoke("delete_private_key_passphrase", { hostId });
  }
  await removeCredentialReference("privateKeyPassphrase", hostId);
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

function formatTime(value?: string) {
  if (!value) return "从未连接";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function resolveManagedPrivateKey(
  host: HostRecord,
  sshKeys: SshKeyRecord[],
) {
  if (host.authMethod !== "privateKey" || !host.sshKeyId) return host;
  const sshKey = sshKeys.find((item) => item.id === host.sshKeyId);
  return sshKey ? { ...host, privateKeyPath: sshKey.privateKeyPath } : undefined;
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
  const [sshKeys, setSshKeys] = useState<SshKeyRecord[]>([]);
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
  const [quickSshKeyId, setQuickSshKeyId] = useState<string>();
  const [quickProxyId, setQuickProxyId] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void purgeExpiredDeletedHosts()
      .then(async ({ configuration, expiredHostIds }) => {
        if (disposed) return;
        setHosts(configuration.hosts);
        setHistory(configuration.history);
        setProxies(configuration.proxies);
        setSshKeys(configuration.sshKeys);
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
    void listenProtocolEvent("configuration:changed", () => {
      void loadConfiguration()
        .then((configuration) => {
          if (disposed) return;
          setHosts(configuration.hosts);
          setHistory(configuration.history);
          setProxies(configuration.proxies);
          setSshKeys(configuration.sshKeys);
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

    let passwordStored = false;
    let passphraseStored = false;
    try {
      if (password) {
        await storeHostPassword(hostId, password);
        passwordStored = true;
      }
      if (privateKeyPassphrase) {
        await storePrivateKeyPassphrase(hostId, privateKeyPassphrase);
        passphraseStored = true;
      }
    } catch {
      if (!editingHost) {
        await Promise.allSettled([
          ...(passwordStored ? [removeHostPassword(hostId)] : []),
          ...(passphraseStored
            ? [removePrivateKeyPassphrase(hostId)]
            : []),
        ]);
      }
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
      if (!editingHost) {
        await Promise.allSettled([
          ...(passwordStored ? [removeHostPassword(hostId)] : []),
          ...(passphraseStored
            ? [removePrivateKeyPassphrase(hostId)]
            : []),
        ]);
      }
      Message.error("主机配置保存失败");
      return;
    }
    const indexed = await Promise.allSettled([
      ...(password
        ? [
            upsertCredentialReference(
              createCredentialReference(
                "hostPassword",
                hostId,
                `主机：${normalized.name}`,
              ),
            ),
          ]
        : []),
      ...(privateKeyPassphrase
        ? [
            upsertCredentialReference(
              createCredentialReference(
                "privateKeyPassphrase",
                hostId,
                `主机：${normalized.name}`,
              ),
            ),
          ]
        : []),
    ]);
    if (indexed.some((result) => result.status === "rejected")) {
      Message.warning("主机已保存，但凭据索引更新失败，可在隐私与清理中重新扫描");
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
        await emitProtocolEventTo("settings", "configuration:changed").catch(
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
        const result = await invoke<{
          passwordCopied: boolean;
          passphraseCopied: boolean;
        }>("copy_host_credentials", {
          sourceHostId: host.id,
          targetHostId: copiedHost.id,
        });
        credentialsCopied = true;
        if (result.passwordCopied) {
          await upsertCredentialReference(
            createCredentialReference(
              "hostPassword",
              copiedHost.id,
              `主机：${copiedHost.name}`,
            ),
          );
        }
        if (result.passphraseCopied) {
          await upsertCredentialReference(
            createCredentialReference(
              "privateKeyPassphrase",
              copiedHost.id,
              `主机：${copiedHost.name}`,
            ),
          );
        }
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
    let connectionSshKeys = sshKeys;
    const proxy = host.proxyId
      ? proxies.find((item) => item.id === host.proxyId)
      : undefined;
    if (host.proxyId && !proxy) {
      Message.error("主机引用的代理不存在，请重新编辑主机");
      return;
    }
    let jumpHost = host.jumpHostId
      ? hosts.find((item) => item.id === host.jumpHostId)
      : undefined;
    if (host.jumpHostId && jumpHost && !jumpHost.hostFingerprint) {
      try {
        const configuration = await loadConfiguration();
        setHosts(configuration.hosts);
        setSshKeys(configuration.sshKeys);
        connectionSshKeys = configuration.sshKeys;
        jumpHost = configuration.hosts.find(
          (item) => item.id === host.jumpHostId,
        );
      } catch {
        // The existing in-memory validation below will provide the actionable error.
      }
    }
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
    const resolvedHost = resolveManagedPrivateKey(host, connectionSshKeys);
    if (!resolvedHost) {
      Message.error("主机引用的私钥不存在，请重新编辑主机");
      return;
    }
    const resolvedJumpHost = jumpHost
      ? resolveManagedPrivateKey(jumpHost, connectionSshKeys)
      : undefined;
    if (jumpHost && !resolvedJumpHost) {
      Message.error("跳板机引用的私钥不存在，请重新编辑跳板机");
      return;
    }
    const now = new Date().toISOString();
    const identity = connectionTargetKey(host);
    const storedConnectedHost = { ...host, lastConnectedAt: now };
    const connectedHost = { ...resolvedHost, lastConnectedAt: now };
    const historyRecord: ConnectionHistoryRecord = {
      id: createId("history"),
      hostId: host.id.startsWith("quick-") ? undefined : host.id,
      name: host.name,
      address: host.address,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      sshKeyId: host.sshKeyId,
      privateKeyPath: host.privateKeyPath,
      hostFingerprint: host.hostFingerprint,
      keepAliveIntervalSeconds: host.keepAliveIntervalSeconds,
      autoReconnect: host.autoReconnect,
      maxReconnectAttempts: host.maxReconnectAttempts,
      proxyId: host.proxyId,
      jumpHostId: host.jumpHostId,
      localPortForwards: host.localPortForwards,
      remotePortForwards: host.remotePortForwards,
      dynamicPortForwards: host.dynamicPortForwards,
      connectedAt: now,
    };

    const nextHosts = hosts.map((item) =>
      item.id === host.id ? storedConnectedHost : item,
    );
    const nextHistory = applyConnectionHistoryPolicy(
      [
        historyRecord,
        ...history.filter((item) => connectionTargetKey(item) !== identity),
      ],
      settings,
      new Date(now),
    );
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
      resolvedJumpHost ? { host: resolvedJumpHost, proxy: jumpProxy } : undefined,
    );
  }

  async function quickConnect() {
    const credentialReady =
      quickAuthMethod === "password"
        ? Boolean(quickPassword)
        : quickAuthMethod === "privateKey"
          ? Boolean(quickSshKeyId)
          : true;
    if (!quickTarget.address.trim() || !credentialReady) return;

    const normalized = {
      ...quickTarget,
      address: quickTarget.address.trim(),
      username: quickTarget.username.trim() || "root",
    };
    const host: HostRecord = {
      id: `quick-${connectionTargetKey({ ...normalized, proxyId: quickProxyId })}`,
      name: normalized.address,
      authMethod: quickAuthMethod,
      sshKeyId:
        quickAuthMethod === "privateKey" ? quickSshKeyId : undefined,
      connectTimeoutSeconds: settings.defaultConnectTimeoutSeconds,
      keepAliveIntervalSeconds: settings.defaultKeepAliveIntervalSeconds,
      autoReconnect: settings.defaultAutoReconnect,
      maxReconnectAttempts: settings.defaultMaxReconnectAttempts,
      proxyId: quickProxyId,
      ...normalized,
    };

    let quickPasswordStored = false;
    try {
      if (quickAuthMethod === "password") {
        await storeHostPassword(host.id, quickPassword);
        quickPasswordStored = true;
        await upsertCredentialReference(
          createCredentialReference(
            "hostPassword",
            host.id,
            `快速连接：${host.username}@${host.address}:${host.port}`,
          ),
        ).catch(() => {
          Message.warning("凭据索引更新失败，可在隐私与清理中重新扫描");
        });
      }
      setQuickPassword("");
      await sendConnection(host);
    } catch {
      if (quickPasswordStored) {
        await removeHostPassword(host.id).catch(() => undefined);
      }
      Message.error("认证凭据保存失败，请检查系统凭据库权限");
    }
  }

  function reconnectFromHistory(record: ConnectionHistoryRecord) {
    const savedHost = hosts.find((host) => host.id === record.hostId);
    void sendConnection(
      savedHost ?? {
        id: `quick-${connectionTargetKey(record)}`,
        name: record.name,
        address: record.address,
        port: record.port,
        username: record.username,
        authMethod: record.authMethod ?? "password",
        sshKeyId: record.sshKeyId,
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
        localPortForwards: record.localPortForwards,
        remotePortForwards: record.remotePortForwards,
        dynamicPortForwards: record.dynamicPortForwards,
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
          <HostActions
            disabled={configurationAction}
            host={row.host}
            onConnect={(host) => void sendConnection(host)}
            onCopy={(host) => void copyHost(host)}
            onDelete={deleteHost}
            onEdit={openHostEditor}
          />
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
                  { label: "SSH Agent", value: "agent" },
                ]}
                value={quickAuthMethod}
              />
              {quickAuthMethod === "password" ? (
                <Input.Password
                  onChange={setQuickPassword}
                  placeholder="密码"
                  value={quickPassword}
                />
              ) : quickAuthMethod === "privateKey" ? (
                <Select
                  onChange={setQuickSshKeyId}
                  options={sshKeys.map((sshKey) => ({
                    label: sshKey.name,
                    value: sshKey.id,
                  }))}
                  placeholder="选择私钥"
                  value={quickSshKeyId}
                />
              ) : null}
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
                    : quickAuthMethod === "privateKey"
                      ? !quickSshKeyId
                      : false)
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
          sshKeys={sshKeys}
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
