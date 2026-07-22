import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  Message,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  IconDelete,
  IconEdit,
  IconFolder,
  IconHistory,
  IconLink,
  IconPlus,
} from "@arco-design/web-react/icon";
import type {
  ConnectionHistoryRecord,
  HostFormValues,
  HostAuthMethod,
  HostRecord,
  QuickTarget,
} from "../models";
import HostEditorModal from "./HostEditorModal";
import { normalizeHostForm } from "../host-storage";

const HOSTS_STORAGE_KEY = "fineshell.hosts";
const HISTORY_STORAGE_KEY = "fineshell.connection-history";

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadStoredList<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function loadHosts() {
  return loadStoredList<HostRecord>(HOSTS_STORAGE_KEY).map((host) => ({
    ...host,
    authMethod: host.authMethod ?? "password",
    connectTimeoutSeconds: host.connectTimeoutSeconds ?? 10,
  }));
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
  const [hosts, setHosts] = useState<HostRecord[]>(loadHosts);
  const [history, setHistory] = useState<ConnectionHistoryRecord[]>(() =>
    loadStoredList<ConnectionHistoryRecord>(HISTORY_STORAGE_KEY),
  );
  const [keyword, setKeyword] = useState("");
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
    localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(hosts));
  }, [hosts]);

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [history]);

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

  const filteredHosts = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return hosts;

    return hosts.filter((host) =>
      [host.name, host.address, host.username, host.group]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalized)),
    );
  }, [hosts, keyword]);

  function openHostEditor(host: HostRecord | null) {
    setEditingHost(host);
    setEditorVisible(true);
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

    if (editingHost) {
      setHosts((current) =>
        current.map((host) =>
          host.id === editingHost.id ? { ...host, ...normalized } : host,
        ),
      );
      Message.success("主机信息已更新");
    } else {
      setHosts((current) => [
        ...current,
        { id: hostId, ...normalized },
      ]);
      Message.success("主机已添加");
    }

    setEditorVisible(false);
    setEditingHost(null);
  }

  async function deleteHost(host: HostRecord) {
    const credentialCleanup = await Promise.allSettled([
      removeHostPassword(host.id),
      removePrivateKeyPassphrase(host.id),
    ]);
    if (credentialCleanup.some((result) => result.status === "rejected")) {
      Message.warning("主机已删除，但系统凭据清理失败");
    }
    setHosts((current) => current.filter((item) => item.id !== host.id));
    Message.success(`已删除 ${host.name}`);
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
      connectedAt: now,
    };

    const nextHosts = hosts.map((item) =>
      item.id === host.id ? connectedHost : item,
    );
    const nextHistory = [
      historyRecord,
      ...history.filter((item) => targetKey(item) !== identity),
    ].slice(0, 50);
    setHosts(nextHosts);
    setHistory(nextHistory);
    localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(nextHosts));
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));

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
      connectTimeoutSeconds: 10,
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
        connectTimeoutSeconds: 10,
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
      width: 190,
      render: (_, host) => (
        <Space size="mini">
          <Button
            icon={<IconLink />}
            onClick={() => void sendConnection(host)}
            size="mini"
            type="primary"
          >
            连接
          </Button>
          <Button
            aria-label={`编辑 ${host.name}`}
            icon={<IconEdit />}
            onClick={() => openHostEditor(host)}
            size="mini"
          />
          <Popconfirm
            content={`删除主机“${host.name}”？`}
            onOk={() => void deleteHost(host)}
          >
            <Button
              aria-label={`删除 ${host.name}`}
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
    <main className="host-manager-window">
      <Tabs activeTab={activeTab} onChange={setActiveTab} type="line">
        <Tabs.TabPane key="hosts" title="主机">
          <div className="manager-pane">
            <div className="manager-toolbar">
              <Input.Search
                allowClear
                onChange={setKeyword}
                placeholder="搜索名称、地址或分组"
                value={keyword}
              />
              <Button
                icon={<IconPlus />}
                onClick={() => openHostEditor(null)}
                type="primary"
              >
                新增主机
              </Button>
            </div>
            <Table
              border={false}
              columns={hostColumns}
              data={filteredHosts}
              noDataElement={
                <Empty description={keyword ? "没有匹配的主机" : "暂无主机"} />
              }
              pagination={false}
              rowKey="id"
              size="small"
            />
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
              noDataElement={<Empty description="暂无连接历史" />}
              pagination={false}
              rowKey="id"
              size="small"
            />
          </div>
        </Tabs.TabPane>
      </Tabs>

      {editorVisible && (
        <HostEditorModal
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
