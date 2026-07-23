import { useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tabs,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconFolder } from "@arco-design/web-react/icon";
import type {
  HostFormValues,
  HostRecord,
  ProxyRecord,
  SshKeyRecord,
} from "../models";
import type { AppSettings } from "../app-settings";
import PortForwardRulesEditor from "./PortForwardRulesEditor";

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
  hosts: HostRecord[];
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  visible: boolean;
  onCancel: () => void;
  onChoosePrivateKey: () => Promise<string | undefined>;
  onSubmit: (values: HostFormValues) => void;
}

function HostEditorModal({
  connectionDefaults,
  host,
  hosts,
  proxies,
  sshKeys,
  visible,
  onCancel,
  onChoosePrivateKey,
  onSubmit,
}: HostEditorModalProps) {
  const [form] = Form.useForm<HostEditorValues>();
  const [authMethod, setAuthMethod] = useState(
    host?.authMethod ?? "password",
  );
  const [sshKeyId, setSshKeyId] = useState(host?.sshKeyId);
  const [activeTab, setActiveTab] = useState("basic");
  const [proxyId, setProxyId] = useState(host?.proxyId);
  const [jumpHostId, setJumpHostId] = useState(host?.jumpHostId);
  const [localPortForwards, setLocalPortForwards] = useState(
    host?.localPortForwards ?? [],
  );
  const [remotePortForwards, setRemotePortForwards] = useState(
    host?.remotePortForwards ?? [],
  );
  const [dynamicPortForwards, setDynamicPortForwards] = useState(
    host?.dynamicPortForwards ?? [],
  );

  useEffect(() => {
    if (visible) {
      setActiveTab("basic");
      setSshKeyId(host?.sshKeyId);
      setProxyId(host?.proxyId);
      setJumpHostId(host?.jumpHostId);
      setLocalPortForwards(host?.localPortForwards ?? []);
      setRemotePortForwards(host?.remotePortForwards ?? []);
      setDynamicPortForwards(host?.dynamicPortForwards ?? []);
    }
  }, [visible, host?.id]);

  const initialValues: HostEditorValues = host
    ? {
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        sshKeyId: host.sshKeyId,
        privateKeyPath: host.privateKeyPath,
        privateKeyPassphrase: "",
        password: "",
        group: host.group,
        proxyId: host.proxyId,
        jumpHostId: host.jumpHostId,
      }
    : {
        name: "",
        address: "",
        port: 22,
        username: "root",
        authMethod: "password",
        sshKeyId: undefined,
        privateKeyPath: "",
        privateKeyPassphrase: "",
        password: "",
        group: "",
        proxyId: undefined,
        jumpHostId: undefined,
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
      localPortForwards,
      remotePortForwards,
      dynamicPortForwards,
    });
  };

  return (
    <Modal
      className="host-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: "min(680px, calc(100vw - 64px))" }}
      title={host ? "编辑主机" : "新增主机"}
      visible={visible}
    >
      <Form<HostEditorValues>
        form={form}
        initialValues={initialValues}
        layout="vertical"
        onSubmit={submitHost}
        onSubmitFailed={() => setActiveTab("basic")}
      >
        <Tabs
          activeTab={activeTab}
          animation={false}
          className="host-editor-tabs"
          onChange={setActiveTab}
          tabPosition="left"
          type="line"
        >
          <Tabs.TabPane key="basic" title="基础信息">
            <div className="host-editor-tab-pane">
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
                    { label: "SSH Agent", value: "agent" },
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
              ) : authMethod === "privateKey" ? (
                <>
                  <Form.Item
                    field="sshKeyId"
                    label="私钥"
                    rules={
                      host?.privateKeyPath && !sshKeyId
                        ? undefined
                        : [{ required: true, message: "请选择私钥" }]
                    }
                  >
                    <Select
                      allowClear
                      onChange={setSshKeyId}
                      options={sshKeys.map((sshKey) => ({
                        label: sshKey.name,
                        value: sshKey.id,
                      }))}
                      placeholder="从密钥管理中选择"
                    />
                  </Form.Item>
                  {!sshKeyId && host?.privateKeyPath ? (
                    <>
                      <Typography.Text type="secondary">
                        当前主机使用旧版直接私钥配置，可继续使用或改选集中管理的密钥。
                      </Typography.Text>
                      <Form.Item field="privateKeyPath" label="私钥文件">
                        <Input.Search
                          onSearch={() =>
                            void onChoosePrivateKey().then((path) => {
                              if (path) {
                                form.setFieldValue("privateKeyPath", path);
                              }
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
                      <Form.Item
                        field="privateKeyPassphrase"
                        label="私钥口令"
                      >
                        <Input.Password placeholder="留空则保留原口令" />
                      </Form.Item>
                    </>
                  ) : sshKeys.length === 0 ? (
                    <Typography.Text type="secondary">
                      请先在设置的“密钥”中添加私钥。
                    </Typography.Text>
                  ) : null}
                </>
              ) : null}
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane key="route" title="连接链路">
            <div className="host-editor-tab-pane">
              <Form.Item field="proxyId" label="代理">
                <Select
                  allowClear
                  disabled={Boolean(jumpHostId)}
                  onChange={(value) => {
                    setProxyId(value);
                    if (value) {
                      setJumpHostId(undefined);
                      form.setFieldValue("jumpHostId", undefined);
                    }
                  }}
                  options={proxies.map((proxy) => ({
                    label: `${proxy.name} · ${proxy.type === "socks5" ? "SOCKS5" : "HTTP"}`,
                    value: proxy.id,
                  }))}
                  placeholder="直连"
                />
              </Form.Item>
              <Form.Item field="jumpHostId" label="跳板机">
                <Select
                  allowClear
                  disabled={Boolean(proxyId)}
                  onChange={(value) => {
                    setJumpHostId(value);
                    if (value) {
                      setProxyId(undefined);
                      form.setFieldValue("proxyId", undefined);
                    }
                  }}
                  options={hosts
                    .filter(
                      (candidate) =>
                        candidate.id !== host?.id && !candidate.jumpHostId,
                    )
                    .map((candidate) => ({
                      label: `${candidate.name} · ${candidate.username}@${candidate.address}:${candidate.port}`,
                      value: candidate.id,
                    }))}
                  placeholder="不使用跳板机"
                  showSearch
                />
              </Form.Item>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane key="forwards" title="端口转发">
            <div className="host-editor-tab-pane">
              <PortForwardRulesEditor
                dynamicRules={dynamicPortForwards}
                localRules={localPortForwards}
                onDynamicChange={setDynamicPortForwards}
                onLocalChange={setLocalPortForwards}
                onRemoteChange={setRemotePortForwards}
                remoteRules={remotePortForwards}
              />
            </div>
          </Tabs.TabPane>
        </Tabs>
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
