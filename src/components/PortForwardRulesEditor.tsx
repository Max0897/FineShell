import { useState } from "react";
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
  Switch,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconPlus,
} from "@arco-design/web-react/icon";
import type { LocalPortForwardRule } from "../models";

interface PortForwardRulesEditorProps {
  rules: LocalPortForwardRule[];
  onChange: (rules: LocalPortForwardRule[]) => void;
}

function createRuleId() {
  return `forward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function endpoint(address: string, port: number) {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function PortForwardRulesEditor({
  rules,
  onChange,
}: PortForwardRulesEditorProps) {
  const [form] = Form.useForm<LocalPortForwardRule>();
  const [visible, setVisible] = useState(false);
  const [editingRule, setEditingRule] =
    useState<LocalPortForwardRule | null>(null);

  const openEditor = (rule?: LocalPortForwardRule) => {
    const values = rule ?? {
      id: createRuleId(),
      name: "",
      bindAddress: "127.0.0.1",
      bindPort: 8080,
      targetAddress: "127.0.0.1",
      targetPort: 80,
      enabled: true,
    };
    setEditingRule(rule ?? null);
    form.setFieldsValue(values);
    setVisible(true);
  };

  const saveRule = (values: LocalPortForwardRule) => {
    const normalized = {
      ...values,
      id: editingRule?.id ?? values.id,
      name: values.name.trim(),
      bindAddress: values.bindAddress.trim(),
      targetAddress: values.targetAddress.trim(),
    };
    const duplicate = rules.some(
      (rule) =>
        rule.id !== normalized.id &&
        rule.bindAddress === normalized.bindAddress &&
        rule.bindPort === normalized.bindPort,
    );
    if (duplicate) {
      Message.error("该本地监听地址和端口已存在");
      return;
    }

    onChange(
      editingRule
        ? rules.map((rule) =>
            rule.id === editingRule.id ? normalized : rule,
          )
        : [...rules, normalized],
    );
    setVisible(false);
    setEditingRule(null);
  };

  const columns: TableColumnProps<LocalPortForwardRule>[] = [
    {
      dataIndex: "name",
      title: "名称",
      render: (name: string) => (
        <Typography.Text ellipsis={{ showTooltip: true }}>
          {name}
        </Typography.Text>
      ),
    },
    {
      title: "本地监听",
      width: 145,
      render: (_, rule) => endpoint(rule.bindAddress, rule.bindPort),
    },
    {
      title: "目标",
      width: 145,
      render: (_, rule) => endpoint(rule.targetAddress, rule.targetPort),
    },
    {
      title: "启用",
      width: 64,
      render: (_, rule) => (
        <Switch
          checked={rule.enabled}
          onChange={(enabled) =>
            onChange(
              rules.map((item) =>
                item.id === rule.id ? { ...item, enabled } : item,
              ),
            )
          }
          size="small"
        />
      ),
    },
    {
      title: "操作",
      width: 78,
      render: (_, rule) => (
        <Space size="mini">
          <Tooltip content="编辑规则">
            <Button
              aria-label={`编辑 ${rule.name}`}
              icon={<IconEdit />}
              onClick={() => openEditor(rule)}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Popconfirm
            content={`删除端口转发“${rule.name}”？`}
            onOk={() =>
              onChange(rules.filter((item) => item.id !== rule.id))
            }
          >
            <Tooltip content="删除规则">
              <Button
                aria-label={`删除 ${rule.name}`}
                icon={<IconDelete />}
                size="mini"
                status="danger"
                type="text"
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="port-forward-rules-editor">
      <div className="port-forward-rules-toolbar">
        <Typography.Text bold>本地端口转发</Typography.Text>
        <Button
          icon={<IconPlus />}
          onClick={() => openEditor()}
          size="small"
          type="primary"
        >
          新增规则
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={rules}
        noDataElement={<Empty description="暂无转发规则" />}
        pagination={false}
        rowKey="id"
        size="small"
      />

      <Modal
        className="port-forward-rule-modal"
        footer={null}
        maskClosable={false}
        onCancel={() => setVisible(false)}
        style={{ width: 560 }}
        title={editingRule ? "编辑转发规则" : "新增转发规则"}
        visible={visible}
      >
        <Form<LocalPortForwardRule>
          form={form}
          layout="vertical"
          onSubmit={saveRule}
        >
          <Form.Item field="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            field="name"
            label="名称"
            rules={[{ required: true, message: "请输入规则名称" }]}
          >
            <Input autoFocus placeholder="例如：本地访问数据库" />
          </Form.Item>
          <div className="port-forward-rule-row">
            <Form.Item
              field="bindAddress"
              label="本地监听地址"
              rules={[{ required: true, message: "请选择监听地址" }]}
            >
              <Select
                options={[
                  { label: "127.0.0.1", value: "127.0.0.1" },
                  { label: "0.0.0.0", value: "0.0.0.0" },
                  { label: "::1", value: "::1" },
                ]}
              />
            </Form.Item>
            <Form.Item
              field="bindPort"
              label="本地端口"
              rules={[{ required: true, message: "请输入本地端口" }]}
            >
              <InputNumber max={65535} min={1} mode="button" />
            </Form.Item>
          </div>
          <div className="port-forward-rule-row">
            <Form.Item
              field="targetAddress"
              label="目标地址"
              rules={[{ required: true, message: "请输入目标地址" }]}
            >
              <Input placeholder="目标服务器可访问的地址" />
            </Form.Item>
            <Form.Item
              field="targetPort"
              label="目标端口"
              rules={[{ required: true, message: "请输入目标端口" }]}
            >
              <InputNumber max={65535} min={1} mode="button" />
            </Form.Item>
          </div>
          <Form.Item
            field="enabled"
            label="连接后自动启用"
            triggerPropName="checked"
          >
            <Switch />
          </Form.Item>
          <div className="modal-actions">
            <Space>
              <Button onClick={() => setVisible(false)}>取消</Button>
              <Button htmlType="submit" type="primary">
                保存
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </div>
  );
}

export default PortForwardRulesEditor;
