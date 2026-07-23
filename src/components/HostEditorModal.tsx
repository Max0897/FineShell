import { useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tooltip,
} from "@arco-design/web-react";
import { IconFolder } from "@arco-design/web-react/icon";
import type { HostFormValues, HostRecord, ProxyRecord } from "../models";
import type { AppSettings } from "../app-settings";

type ConnectionDefaults = Pick<
  AppSettings,
  | "defaultConnectTimeoutSeconds"
  | "defaultKeepAliveIntervalSeconds"
  | "defaultAutoReconnect"
  | "defaultMaxReconnectAttempts"
>;

type HostEditorValues = Omit<
  HostFormValues,
  | "connectTimeoutSeconds"
  | "keepAliveIntervalSeconds"
  | "autoReconnect"
  | "maxReconnectAttempts"
  | "hostFingerprint"
>;

interface HostEditorModalProps {
  connectionDefaults: ConnectionDefaults;
  host: HostRecord | null;
  proxies: ProxyRecord[];
  visible: boolean;
  onCancel: () => void;
  onChoosePrivateKey: () => Promise<string | undefined>;
  onSubmit: (values: HostFormValues) => void;
}

function HostEditorModal({
  connectionDefaults,
  host,
  proxies,
  visible,
  onCancel,
  onChoosePrivateKey,
  onSubmit,
}: HostEditorModalProps) {
  const [form] = Form.useForm<HostEditorValues>();
  const [authMethod, setAuthMethod] = useState(
    host?.authMethod ?? "password",
  );
  const initialValues: HostEditorValues = host
    ? {
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        privateKeyPath: host.privateKeyPath,
        privateKeyPassphrase: "",
        password: "",
        group: host.group,
        proxyId: host.proxyId,
      }
    : {
        name: "",
        address: "",
        port: 22,
        username: "root",
        authMethod: "password",
        privateKeyPath: "",
        privateKeyPassphrase: "",
        password: "",
        group: "",
        proxyId: undefined,
      };

  const submitHost = (values: HostEditorValues) => {
    const targetUnchanged =
      host &&
      host.address === values.address.trim() &&
      host.port === values.port &&
      host.username === values.username.trim();
    onSubmit({
      ...values,
      connectTimeoutSeconds:
        host?.connectTimeoutSeconds ??
        connectionDefaults.defaultConnectTimeoutSeconds,
      keepAliveIntervalSeconds:
        host?.keepAliveIntervalSeconds ??
        connectionDefaults.defaultKeepAliveIntervalSeconds,
      autoReconnect:
        host?.autoReconnect ?? connectionDefaults.defaultAutoReconnect,
      maxReconnectAttempts:
        host?.maxReconnectAttempts ??
        connectionDefaults.defaultMaxReconnectAttempts,
      hostFingerprint: targetUnchanged ? host.hostFingerprint : undefined,
    });
  };

  return (
    <Modal
      className="host-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 520 }}
      title={host ? "编辑主机" : "新增主机"}
      visible={visible}
    >
      <Form<HostEditorValues>
        form={form}
        initialValues={initialValues}
        layout="vertical"
        onSubmit={submitHost}
      >
        <div className="host-form-row">
          <Form.Item
            field="name"
            label="名称"
            rules={[{ required: true, message: "请输入主机名称" }]}
          >
            <Input autoFocus placeholder="例如：生产服务器" />
          </Form.Item>
          <Form.Item field="group" label="分组">
            <Input placeholder="可选" />
          </Form.Item>
        </div>
        <div className="host-form-row">
          <Form.Item
            field="address"
            label="主机地址"
            rules={[{ required: true, message: "请输入 IP 地址或域名" }]}
          >
            <Input placeholder="192.168.1.10 或 server.example.com" />
          </Form.Item>
          <Form.Item
            field="port"
            label="SSH 端口"
            rules={[{ required: true, message: "请输入端口" }]}
          >
            <InputNumber max={65535} min={1} mode="button" />
          </Form.Item>
        </div>
        <Form.Item
          field="username"
          label="用户名"
          rules={[{ required: true, message: "请输入用户名" }]}
        >
          <Input placeholder="root" />
        </Form.Item>
        <Form.Item field="authMethod" label="认证方式">
          <Select
            onChange={setAuthMethod}
            options={[
              { label: "密码认证", value: "password" },
              { label: "私钥认证", value: "privateKey" },
            ]}
          />
        </Form.Item>
        {authMethod === "password" ? (
          <Form.Item
            field="password"
            label="密码"
            rules={
              host?.authMethod === "password"
                ? undefined
                : [{ required: true, message: "请输入登录密码" }]
            }
          >
            <Input.Password
              placeholder={host ? "留空则保留原密码" : "登录密码"}
            />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              field="privateKeyPath"
              label="私钥文件"
              rules={[{ required: true, message: "请选择私钥文件" }]}
            >
              <Input.Search
                onSearch={() =>
                  void onChoosePrivateKey().then((path) => {
                    if (path) form.setFieldValue("privateKeyPath", path);
                  })
                }
                placeholder="选择或输入私钥文件路径"
                searchButton={
                  <Tooltip content="选择私钥文件">
                    <IconFolder />
                  </Tooltip>
                }
              />
            </Form.Item>
            <Form.Item field="privateKeyPassphrase" label="私钥口令">
              <Input.Password
                placeholder={
                  host?.authMethod === "privateKey"
                    ? "留空则保留原口令"
                    : "没有口令可留空"
                }
              />
            </Form.Item>
          </>
        )}
        <Form.Item field="proxyId" label="代理">
          <Select
            allowClear
            options={proxies.map((proxy) => ({
              label: `${proxy.name} · ${proxy.type === "socks5" ? "SOCKS5" : "HTTP"}`,
              value: proxy.id,
            }))}
            placeholder="直连"
          />
        </Form.Item>
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

export default HostEditorModal;
