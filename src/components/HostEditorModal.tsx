import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
} from "@arco-design/web-react";
import type { HostFormValues, HostRecord } from "../models";

interface HostEditorModalProps {
  host: HostRecord | null;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: HostFormValues) => void;
}

function HostEditorModal({
  host,
  visible,
  onCancel,
  onSubmit,
}: HostEditorModalProps) {
  const initialValues: HostFormValues = host
    ? {
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        connectTimeoutSeconds: host.connectTimeoutSeconds,
        password: "",
        group: host.group,
        hostFingerprint: host.hostFingerprint,
      }
    : {
        name: "",
        address: "",
        port: 22,
        username: "root",
        authMethod: "password",
        connectTimeoutSeconds: 10,
        password: "",
        group: "",
        hostFingerprint: "",
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
      <Form<HostFormValues>
        initialValues={initialValues}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <Form.Item
          field="name"
          label="名称"
          rules={[{ required: true, message: "请输入主机名称" }]}
        >
          <Input autoFocus placeholder="例如：生产服务器" />
        </Form.Item>
        <Form.Item
          field="address"
          label="主机地址"
          rules={[{ required: true, message: "请输入 IP 地址或域名" }]}
        >
          <Input placeholder="192.168.1.10 或 server.example.com" />
        </Form.Item>
        <div className="host-form-row">
          <Form.Item
            field="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item
            field="port"
            label="SSH 端口"
            rules={[{ required: true, message: "请输入端口" }]}
          >
            <InputNumber max={65535} min={1} mode="button" />
          </Form.Item>
        </div>
        <Form.Item field="authMethod" label="认证方式">
          <Select
            options={[{ label: "密码认证", value: "password" }]}
          />
        </Form.Item>
        <Form.Item
          field="password"
          label="密码"
          rules={
            host
              ? undefined
              : [{ required: true, message: "请输入登录密码" }]
          }
        >
          <Input.Password
            placeholder={host ? "留空则保留原密码" : "登录密码"}
          />
        </Form.Item>
        <Form.Item
          field="connectTimeoutSeconds"
          label="连接超时（秒）"
          rules={[{ required: true, message: "请输入连接超时时间" }]}
        >
          <InputNumber max={120} min={3} mode="button" />
        </Form.Item>
        <Form.Item field="hostFingerprint" label="主机指纹">
          <Input placeholder="首次连接后自动记录，也可预先填写 SHA256 指纹" />
        </Form.Item>
        <Form.Item field="group" label="分组">
          <Input placeholder="可选" />
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
