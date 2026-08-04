import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconPlus,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  loadConfiguration,
} from "../config-database";
import {
  deleteProxy,
  removeCredentialReference,
  upsertCredentialReference,
  upsertProxy,
} from "../configuration-mutations";
import { createCredentialReference } from "../credential-registry";
import type {
  ProxyFormValues,
  ProxyRecord,
  ProxyType,
} from "../models";
import {
  emitProtocolEventTo,
  listenProtocolEvent,
} from "../tauri-protocol";

function createProxyId() {
  return `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function storeProxyPassword(proxyId: string, password: string) {
  if (!isTauri()) return;
  await invoke("store_proxy_password", { proxyId, password });
}

async function removeProxyPassword(proxyId: string) {
  if (isTauri()) await invoke("delete_proxy_password", { proxyId });
  await removeCredentialReference("proxyPassword", proxyId);
}

interface ProxyEditorModalProps {
  proxy: ProxyRecord | null;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: ProxyFormValues) => void;
}

function ProxyEditorModal({
  proxy,
  visible,
  onCancel,
  onSubmit,
}: ProxyEditorModalProps) {
  const [form] = Form.useForm<ProxyFormValues>();
  const [proxyType, setProxyType] = useState<ProxyType>(
    proxy?.type ?? "socks5",
  );
  const [username, setUsername] = useState(proxy?.username ?? "");

  return (
    <Modal
      className="proxy-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 520 }}
      title={proxy ? "编辑代理" : "新增代理"}
      visible={visible}
    >
      <Form<ProxyFormValues>
        form={form}
        initialValues={{
          name: proxy?.name ?? "",
          type: proxyType,
          address: proxy?.address ?? "",
          port: proxy?.port ?? 1080,
          username,
          password: "",
        }}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <Form.Item
          field="name"
          label="名称"
          rules={[{ required: true, message: "请输入代理名称" }]}
        >
          <Input autoFocus placeholder="例如：办公网络代理" />
        </Form.Item>
        <Form.Item field="type" label="代理类型">
          <Select
            onChange={(value) => {
              const nextType = value as ProxyType;
              setProxyType(nextType);
              if (!proxy) {
                form.setFieldValue("port", nextType === "http" ? 8080 : 1080);
              }
            }}
            options={[
              { label: "SOCKS5", value: "socks5" },
              { label: "HTTP CONNECT", value: "http" },
            ]}
          />
        </Form.Item>
        <div className="proxy-form-row">
          <Form.Item
            field="address"
            label="代理地址"
            rules={[{ required: true, message: "请输入代理地址" }]}
          >
            <Input placeholder="127.0.0.1 或 proxy.example.com" />
          </Form.Item>
          <Form.Item
            field="port"
            label="端口"
            rules={[{ required: true, message: "请输入端口" }]}
          >
            <InputNumber max={65535} min={1} mode="button" />
          </Form.Item>
        </div>
        <Form.Item field="username" label="用户名">
          <Input
            onChange={setUsername}
            placeholder="无需认证可留空"
          />
        </Form.Item>
        {username.trim() && (
          <Form.Item
            field="password"
            label="密码"
            rules={
              proxy?.username
                ? undefined
                : [{ required: true, message: "请输入代理密码" }]
            }
          >
            <Input.Password
              placeholder={proxy?.username ? "留空则保留原密码" : "代理密码"}
            />
          </Form.Item>
        )}
        <div className="modal-actions">
          <Space>
            <Button onClick={onCancel}>取消</Button>
            <Button htmlType="submit" type="primary">
              保存
            </Button>
          </Space>
        </div>
      </Form>
    </Modal>
  );
}

function ProxySettings() {
  const [proxies, setProxies] = useState<ProxyRecord[]>([]);
  const [hostUsage, setHostUsage] = useState(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingProxy, setEditingProxy] = useState<ProxyRecord | null>(null);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setProxies(configuration.proxies);
    const usage = new Map<string, number>();
    for (const host of configuration.hosts) {
      if (host.proxyId) usage.set(host.proxyId, (usage.get(host.proxyId) ?? 0) + 1);
    }
    setHostUsage(usage);
  }, []);

  useEffect(() => {
    let disposed = false;
    void refresh()
      .catch((error) => {
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void refresh().catch((error) => Message.error(String(error)));
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const notifyMainWindow = async () => {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(
      () => undefined,
    );
  };

  const saveProxy = async (values: ProxyFormValues) => {
    const proxyId = editingProxy?.id ?? createProxyId();
    const username = values.username?.trim() || undefined;
    const password = values.password;
    if (username && !editingProxy?.username && !password) {
      Message.error("请输入代理密码");
      return;
    }

    const proxy: ProxyRecord = {
      id: proxyId,
      name: values.name.trim(),
      type: values.type,
      address: values.address.trim(),
      port: values.port,
      username,
    };
    setActing(true);
    let passwordStored = false;
    try {
      if (username && password) {
        await storeProxyPassword(proxyId, password);
        passwordStored = true;
      }
      const configuration = await upsertProxy(proxy);
      setProxies(configuration.proxies);
      if (username && password) {
        await upsertCredentialReference(
          createCredentialReference(
            "proxyPassword",
            proxyId,
            `代理：${proxy.name}`,
          ),
        ).catch(() => {
          Message.warning("代理已保存，但凭据索引更新失败，可重新扫描");
        });
      }
      if (!username) await removeProxyPassword(proxyId);
      await notifyMainWindow();
      setEditorVisible(false);
      setEditingProxy(null);
      Message.success(editingProxy ? "代理已更新" : "代理已添加");
    } catch (error) {
      if (!editingProxy && passwordStored) {
        await removeProxyPassword(proxyId).catch(() => undefined);
      }
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeProxy = async (proxy: ProxyRecord) => {
    setActing(true);
    try {
      const configuration = await deleteProxy(proxy.id);
      setProxies(configuration.proxies);
      setHostUsage((current) => {
        const next = new Map(current);
        next.delete(proxy.id);
        return next;
      });
      await notifyMainWindow();
      try {
        await removeProxyPassword(proxy.id);
        Message.success(`已删除 ${proxy.name}`);
      } catch {
        Message.warning("代理已删除，但系统凭据清理失败");
      }
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = useMemo<TableColumnProps<ProxyRecord>[]>(
    () => [
      {
        title: "代理",
        dataIndex: "name",
        render: (_, proxy) => (
          <div className="proxy-name-cell">
            <Typography.Text bold>{proxy.name}</Typography.Text>
            <Typography.Text type="secondary">
              {proxy.type === "socks5" ? "SOCKS5" : "HTTP CONNECT"}
            </Typography.Text>
          </div>
        ),
      },
      {
        title: "地址",
        render: (_, proxy) => `${proxy.address}:${proxy.port}`,
      },
      {
        title: "认证",
        width: 120,
        render: (_, proxy) => proxy.username || "无需认证",
      },
      {
        title: "使用主机",
        width: 100,
        render: (_, proxy) => `${hostUsage.get(proxy.id) ?? 0} 台`,
      },
      {
        title: "操作",
        width: 100,
        render: (_, proxy) => (
          <Space size="mini">
            <Button
              aria-label={`编辑 ${proxy.name}`}
              disabled={acting}
              icon={<IconEdit />}
              onClick={() => {
                setEditingProxy(proxy);
                setEditorVisible(true);
              }}
              size="mini"
            />
            <Popconfirm
              content={
                (hostUsage.get(proxy.id) ?? 0) > 0
                  ? `删除后，使用该代理的主机将改为直连。确定删除“${proxy.name}”？`
                  : `确定删除代理“${proxy.name}”？`
              }
              onOk={() => void removeProxy(proxy)}
            >
              <Button
                aria-label={`删除 ${proxy.name}`}
                disabled={acting}
                icon={<IconDelete />}
                size="mini"
                status="danger"
              />
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [acting, hostUsage],
  );

  return (
    <div className="proxy-settings">
      <div className="proxy-settings-heading">
        <Button
          disabled={loading || acting}
          icon={<IconPlus />}
          onClick={() => {
            setEditingProxy(null);
            setEditorVisible(true);
          }}
          type="primary"
        >
          新增代理
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={proxies}
        loading={loading}
        noDataElement={<Empty description="暂无代理" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
      {editorVisible && (
        <ProxyEditorModal
          onCancel={() => {
            setEditorVisible(false);
            setEditingProxy(null);
          }}
          onSubmit={(values) => void saveProxy(values)}
          proxy={editingProxy}
          visible
        />
      )}
    </div>
  );
}

export default ProxySettings;
