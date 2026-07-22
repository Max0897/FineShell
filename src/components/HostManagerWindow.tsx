import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import type { TreeDataType } from "@arco-design/web-react/es/Tree/interface";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  IconDelete,
  IconCopy,
  IconEdit,
  IconExport,
  IconFolder,
  IconHistory,
  IconImport,
  IconLink,
  IconPlus,
  IconSort,
  IconStorage,
  IconUndo,
} from "@arco-design/web-react/icon";
import type {
  ConnectionHistoryRecord,
  HostFormValues,
  HostAuthMethod,
  HostRecord,
  HostSortMode,
  QuickTarget,
} from "../models";
import HostEditorModal from "./HostEditorModal";
import { normalizeHostForm } from "../host-storage";
import {
  ALL_HOSTS_GROUP_KEY,
  buildHostGroupTree,
  collectHostGroupKeys,
  createHostCopy,
  filterHostsByGroup,
  sortHosts,
  type HostGroupTreeNode,
} from "../host-organization";
import {
  type ConfigurationBackup,
  type DeletedHostRecord,
  importConfiguration,
  loadConfiguration,
  moveHostToTrash,
  parseConfigurationExport,
  permanentlyDeleteHost,
  purgeExpiredDeletedHosts,
  replaceConfigurationContent,
  restoreConfigurationBackup,
  restoreDeletedHost,
  serializeConfigurationExport,
  updateHostSortMode,
} from "../config-database";
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from "../app-settings";

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
  target: Pick<HostRecord, "address" | "port" | "username">,
) {
  return `${target.username}@${target.address}:${target.port}`;
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

function HostManagerWindow() {
  const initialTab =
    new URLSearchParams(window.location.search).get("tab") === "history"
      ? "history"
      : "hosts";
  const [activeTab, setActiveTab] = useState(initialTab);
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [history, setHistory] = useState<ConnectionHistoryRecord[]>([]);
  const [backups, setBackups] = useState<ConfigurationBackup[]>([]);
  const [trash, setTrash] = useState<DeletedHostRecord[]>([]);
  const [hostSort, setHostSort] = useState<HostSortMode>("manual");
  const [appSettings, setAppSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [configurationAction, setConfigurationAction] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [selectedGroupKey, setSelectedGroupKey] = useState(
    ALL_HOSTS_GROUP_KEY,
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<string[]>([]);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingHost, setEditingHost] = useState<HostRecord | null>(null);
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

  useEffect(() => {
    document.title = "主机管理";
  }, []);

  useEffect(() => {
    let disposed = false;
    void purgeExpiredDeletedHosts()
      .then(async ({ configuration, expiredHostIds }) => {
        if (disposed) return;
        setHosts(configuration.hosts);
        setHistory(configuration.history);
        setBackups(configuration.backups);
        setTrash(configuration.trash);
        setHostSort(configuration.hostSort);
        setAppSettings(configuration.settings);

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
    void listen<AppSettings>("settings:changed", ({ payload }) => {
      setAppSettings(sanitizeAppSettings(payload));
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
    void listen<string>("host-manager:show-tab", ({ payload }) => {
      setActiveTab(payload === "history" ? "history" : "hosts");
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

  const hostGroupTree = useMemo(() => buildHostGroupTree(hosts), [hosts]);
  const hostGroupKeys = useMemo(
    () => collectHostGroupKeys(hostGroupTree),
    [hostGroupTree],
  );
  const hostGroupTreeData = useMemo<TreeDataType[]>(() => {
    const toTreeData = (nodes: HostGroupTreeNode[]): TreeDataType[] =>
      nodes.map((node) => ({
        children: node.children ? toTreeData(node.children) : undefined,
        icon: node.key.startsWith("host-group:") ? <IconFolder /> : undefined,
        key: node.key,
        title: (
          <span className="host-group-tree-title">
            <span>{node.title}</span>
            <span className="host-group-tree-count">{node.count}</span>
          </span>
        ),
      }));
    return toTreeData(hostGroupTree);
  }, [hostGroupTree]);

  useEffect(() => {
    setExpandedGroupKeys((current) => [
      ...new Set([...current, ...hostGroupKeys]),
    ]);
  }, [hostGroupKeys]);

  useEffect(() => {
    const availableKeys = new Set(
      hostGroupTree.flatMap((node) => [node.key, ...collectHostGroupKeys([node])]),
    );
    if (!availableKeys.has(selectedGroupKey)) {
      setSelectedGroupKey(ALL_HOSTS_GROUP_KEY);
    }
  }, [hostGroupTree, selectedGroupKey]);

  const filteredHosts = useMemo(() => {
    const groupedHosts = filterHostsByGroup(hosts, selectedGroupKey);
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return groupedHosts;

    return groupedHosts.filter((host) =>
      [host.name, host.address, host.username, host.group]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized)),
    );
  }, [hosts, keyword, selectedGroupKey]);
  const visibleHosts = useMemo(
    () => sortHosts(filteredHosts, hostSort),
    [filteredHosts, hostSort],
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

  async function exportConfiguration() {
    if (!isTauri()) {
      Message.warning("配置导出仅支持桌面应用");
      return;
    }

    setConfigurationAction(true);
    try {
      const path = await saveDialog({
        defaultPath: `fineshell-config-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "FineShell 配置", extensions: ["json"] }],
        title: "导出 FineShell 配置",
      });
      if (!path) return;

      const configuration = await loadConfiguration();
      await invoke("write_config_file", {
        path,
        contents: serializeConfigurationExport(configuration),
      });
      Message.success("配置已导出");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function importConfigurationFile() {
    if (!isTauri()) {
      Message.warning("配置导入仅支持桌面应用");
      return;
    }

    setConfigurationAction(true);
    try {
      const path = await open({
        directory: false,
        filters: [{ name: "FineShell 配置", extensions: ["json"] }],
        multiple: false,
        title: "导入 FineShell 配置",
      });
      if (typeof path !== "string") return;

      const contents = await invoke<string>("read_config_file", { path });
      const imported = parseConfigurationExport(contents);
      Modal.confirm({
        cancelText: "取消",
        content: (
          <Typography.Paragraph>
            将导入 {imported.hosts.length} 台主机和 {imported.history.length}
            条连接记录。当前配置会先自动备份，认证凭据不会被导入或覆盖。
          </Typography.Paragraph>
        ),
        okText: "确认导入",
        onOk: async () => {
          setConfigurationAction(true);
          try {
            const next = await importConfiguration(imported);
            setHosts(next.hosts);
            setHistory(next.history);
            setBackups(next.backups);
            setTrash(next.trash);
            setHostSort(next.hostSort);
            setAppSettings(next.settings);
            if (isTauri()) {
              await emitTo("main", "settings:changed", next.settings);
            }
            Message.success("配置导入完成");
          } catch (error) {
            Message.error(String(error));
            throw error;
          } finally {
            setConfigurationAction(false);
          }
        },
        title: "确认导入配置",
      });
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function restoreBackup(backup: ConfigurationBackup) {
    setConfigurationAction(true);
    try {
      const next = await restoreConfigurationBackup(backup.id);
      setHosts(next.hosts);
      setHistory(next.history);
      setBackups(next.backups);
      setTrash(next.trash);
      setHostSort(next.hostSort);
      Message.success("配置已恢复");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function saveHost(values: HostFormValues) {
    const { password, privateKeyPassphrase, host: normalized } =
      normalizeHostForm(values);
    const hostId = editingHost?.id ?? createId("host");

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
      setBackups(next.backups);
      setTrash(next.trash);
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

  async function restoreTrashedHost(deletedHost: DeletedHostRecord) {
    setConfigurationAction(true);
    try {
      const next = await restoreDeletedHost(deletedHost.id);
      setHosts(next.hosts);
      setTrash(next.trash);
      Message.success(`已恢复 ${deletedHost.host.name}`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function permanentlyDeleteTrashedHost(
    deletedHost: DeletedHostRecord,
  ) {
    setConfigurationAction(true);
    try {
      const next = await permanentlyDeleteHost(deletedHost.id);
      setTrash(next.trash);
      const hostIdIsActive = next.hosts.some(
        (host) => host.id === deletedHost.host.id,
      );
      const credentialCleanup = hostIdIsActive
        ? []
        : await Promise.allSettled([
            removeHostPassword(deletedHost.host.id),
            removePrivateKeyPassphrase(deletedHost.host.id),
          ]);
      if (credentialCleanup.some((result) => result.status === "rejected")) {
        Message.warning("主机已永久删除，但部分系统凭据清理失败");
      } else {
        Message.success(`已永久删除 ${deletedHost.host.name}`);
      }
    } catch (error) {
      Message.error(String(error));
    } finally {
      setConfigurationAction(false);
    }
  }

  async function sendConnection(host: HostRecord) {
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

    if (isTauri()) {
      await emitTo("main", "host-connect", connectedHost);
      await getCurrentWindow().close();
      return;
    }

    window.opener?.postMessage(
      { type: "fineshell:host-connect", host: connectedHost },
      window.location.origin,
    );
    window.close();
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
      id: `quick-${targetKey(normalized)}`,
      name: normalized.address,
      authMethod: quickAuthMethod,
      privateKeyPath:
        quickAuthMethod === "privateKey"
          ? quickPrivateKeyPath.trim()
          : undefined,
      connectTimeoutSeconds: appSettings.defaultConnectTimeoutSeconds,
      keepAliveIntervalSeconds:
        appSettings.defaultKeepAliveIntervalSeconds,
      autoReconnect: appSettings.defaultAutoReconnect,
      maxReconnectAttempts: appSettings.defaultMaxReconnectAttempts,
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
        connectTimeoutSeconds: appSettings.defaultConnectTimeoutSeconds,
        keepAliveIntervalSeconds:
          record.keepAliveIntervalSeconds ??
          appSettings.defaultKeepAliveIntervalSeconds,
        autoReconnect:
          record.autoReconnect ?? appSettings.defaultAutoReconnect,
        maxReconnectAttempts:
          record.maxReconnectAttempts ??
          appSettings.defaultMaxReconnectAttempts,
      },
    );
  }

  const hostColumns: TableColumnProps<HostRecord>[] = [
    {
      title: "主机",
      dataIndex: "name",
      render: (_, host) => (
        <div className="host-name-cell">
          <Typography.Text bold>{host.name}</Typography.Text>
          <Typography.Text type="secondary">
            {host.username}@{host.address}:{host.port}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "分组",
      dataIndex: "group",
      width: 120,
      render: (value) =>
        value ? <Tag color="arcoblue">{value}</Tag> : <span>-</span>,
    },
    {
      title: "最近连接",
      dataIndex: "lastConnectedAt",
      width: 150,
      render: (value) => formatTime(value),
    },
    {
      title: "操作",
      width: 228,
      render: (_, host) => (
        <Space size="mini">
          <Button
            disabled={configurationAction}
            icon={<IconLink />}
            onClick={() => void sendConnection(host)}
            size="mini"
            type="primary"
          >
            连接
          </Button>
          <Button
            aria-label={`编辑 ${host.name}`}
            disabled={configurationAction}
            icon={<IconEdit />}
            onClick={() => openHostEditor(host)}
            size="mini"
          />
          <Tooltip content="复制主机">
            <Button
              aria-label={`复制 ${host.name}`}
              disabled={configurationAction}
              icon={<IconCopy />}
              onClick={() => void copyHost(host)}
              size="mini"
            />
          </Tooltip>
          <Popconfirm
            content={`删除主机“${host.name}”？`}
            onOk={() => void deleteHost(host)}
          >
            <Button
              aria-label={`删除 ${host.name}`}
              disabled={configurationAction}
              icon={<IconDelete />}
              size="mini"
              status="danger"
            />
          </Popconfirm>
        </Space>
      ),
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

  const backupColumns: TableColumnProps<ConfigurationBackup>[] = [
    {
      title: "备份时间",
      dataIndex: "createdAt",
      width: 180,
      render: (value) => formatTime(value),
    },
    {
      title: "原因",
      dataIndex: "reason",
    },
    {
      title: "内容",
      width: 180,
      render: (_, backup) =>
        `${backup.hosts.length} 台主机，${backup.history.length} 条记录`,
    },
    {
      title: "操作",
      width: 100,
      render: (_, backup) => (
        <Popconfirm
          content="恢复后当前配置会自动备份，是否继续？"
          onOk={() => void restoreBackup(backup)}
        >
          <Button
            disabled={configurationAction}
            icon={<IconUndo />}
            size="mini"
          >
            恢复
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const trashColumns: TableColumnProps<DeletedHostRecord>[] = [
    {
      title: "主机",
      render: (_, deletedHost) => (
        <div className="host-name-cell">
          <Typography.Text bold>{deletedHost.host.name}</Typography.Text>
          <Typography.Text type="secondary">
            {deletedHost.host.username}@{deletedHost.host.address}:
            {deletedHost.host.port}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "删除时间",
      dataIndex: "deletedAt",
      width: 170,
      render: (value) => formatTime(value),
    },
    {
      title: "自动清理时间",
      dataIndex: "expiresAt",
      width: 170,
      render: (value) => formatTime(value),
    },
    {
      title: "操作",
      width: 150,
      render: (_, deletedHost) => (
        <Space size="mini">
          <Button
            aria-label={`恢复 ${deletedHost.host.name}`}
            disabled={configurationAction}
            icon={<IconUndo />}
            onClick={() => void restoreTrashedHost(deletedHost)}
            size="mini"
          />
          <Popconfirm
            content={`永久删除“${deletedHost.host.name}”及其系统凭据？`}
            onOk={() => void permanentlyDeleteTrashedHost(deletedHost)}
          >
            <Button
              aria-label={`永久删除 ${deletedHost.host.name}`}
              disabled={configurationAction}
              icon={<IconDelete />}
              size="mini"
              status="danger"
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <main className="host-manager-window">
      <Tabs activeTab={activeTab} justify onChange={setActiveTab} type="line">
        <Tabs.TabPane className="hosts-tab-pane" key="hosts" title="主机">
          <div className="hosts-manager-layout">
            <aside className="host-group-sidebar">
              <Typography.Text bold>分组</Typography.Text>
              <Tree
                blockNode
                expandedKeys={expandedGroupKeys}
                onExpand={setExpandedGroupKeys}
                onSelect={(keys) => {
                  if (keys[0]) setSelectedGroupKey(keys[0]);
                }}
                selectedKeys={[selectedGroupKey]}
                size="small"
                treeData={hostGroupTreeData}
              />
            </aside>
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
                      onChange={(value) =>
                        void changeHostSort(value as HostSortMode)
                      }
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
                  <Tooltip content="导入配置">
                    <Button
                      aria-label="导入配置"
                      disabled={configurationLoading || configurationAction}
                      icon={<IconImport />}
                      onClick={() => void importConfigurationFile()}
                    />
                  </Tooltip>
                  <Tooltip content="导出配置">
                    <Button
                      aria-label="导出配置"
                      disabled={configurationLoading || configurationAction}
                      icon={<IconExport />}
                      onClick={() => void exportConfiguration()}
                    />
                  </Tooltip>
                  <Button
                    disabled={configurationLoading || configurationAction}
                    icon={<IconPlus />}
                    onClick={() => openHostEditor(null)}
                    type="primary"
                  >
                    新增主机
                  </Button>
                </div>
              </div>
              <Table
                border={false}
                columns={hostColumns}
                data={visibleHosts}
                loading={configurationLoading}
                noDataElement={
                  <Empty
                    description={keyword ? "没有匹配的主机" : "该分组暂无主机"}
                  />
                }
                pagination={false}
                rowKey="id"
                size="small"
              />
            </section>
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane
          key="history"
          title={
            <Space size="mini">
              <IconHistory />
              连接历史
            </Space>
          }
        >
          <div className="manager-pane">
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
        </Tabs.TabPane>
        <Tabs.TabPane
          key="backups"
          title={
            <Space size="mini">
              <IconStorage />
              备份与恢复
            </Space>
          }
        >
          <div className="manager-pane">
            <Table
              border={false}
              columns={backupColumns}
              data={backups}
              loading={configurationLoading || configurationAction}
              noDataElement={<Empty description="暂无自动备份" />}
              pagination={false}
              rowKey="id"
              size="small"
            />
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane
          key="trash"
          title={
            <Space size="mini">
              <IconDelete />
              回收站
            </Space>
          }
        >
          <div className="manager-pane">
            <Table
              border={false}
              columns={trashColumns}
              data={trash}
              loading={configurationLoading || configurationAction}
              noDataElement={<Empty description="回收站为空" />}
              pagination={false}
              rowKey="id"
              size="small"
            />
          </div>
        </Tabs.TabPane>
      </Tabs>

      {editorVisible && (
        <HostEditorModal
          connectionDefaults={appSettings}
          host={editingHost}
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

export default HostManagerWindow;
