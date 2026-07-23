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
  Tabs,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconPlus,
} from "@arco-design/web-react/icon";
import type {
  LocalPortForwardRule,
  RemotePortForwardRule,
} from "../models";

type ForwardKind = "local" | "remote";
type ForwardRule = LocalPortForwardRule | RemotePortForwardRule;

interface PortForwardRulesEditorProps {
  localRules: LocalPortForwardRule[];
  remoteRules: RemotePortForwardRule[];
  onLocalChange: (rules: LocalPortForwardRule[]) => void;
  onRemoteChange: (rules: RemotePortForwardRule[]) => void;
}

interface EditingRule {
  kind: ForwardKind;
  rule: ForwardRule;
}

function createRuleId(kind: ForwardKind) {
  return `${kind}-forward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function endpoint(address: string, port: number) {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function PortForwardRulesEditor({
  localRules,
  remoteRules,
  onLocalChange,
  onRemoteChange,
}: PortForwardRulesEditorProps) {
  const [form] = Form.useForm<ForwardRule>();
  const [activeKind, setActiveKind] = useState<ForwardKind>("local");
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState<EditingRule>();

  const rulesFor = (kind: ForwardKind) =>
    kind === "local" ? localRules : remoteRules;

  const changeRules = (kind: ForwardKind, rules: ForwardRule[]) => {
    if (kind === "local") {
      onLocalChange(rules as LocalPortForwardRule[]);
    } else {
      onRemoteChange(rules as RemotePortForwardRule[]);
    }
  };

  const openEditor = (kind: ForwardKind, rule?: ForwardRule) => {
    const values = rule ?? {
      id: createRuleId(kind),
      name: "",
      bindAddress: "127.0.0.1",
      bindPort: 8080,
      targetAddress: "127.0.0.1",
      targetPort: kind === "local" ? 80 : 3000,
      enabled: true,
    };
    setEditing({ kind, rule: values });
    form.setFieldsValue(values);
    setVisible(true);
  };

  const saveRule = (values: ForwardRule) => {
    if (!editing) return;
    const rules = rulesFor(editing.kind);
    const normalized = {
      ...values,
      id: editing.rule.id,
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
      Message.error(
        `该${editing.kind === "local" ? "本地" : "远程"}监听地址和端口已存在`,
      );
      return;
    }

    changeRules(
      editing.kind,
      rules.some((rule) => rule.id === normalized.id)
        ? rules.map((rule) =>
            rule.id === normalized.id ? normalized : rule,
          )
        : [...rules, normalized],
    );
    setVisible(false);
    setEditing(undefined);
  };

  const columnsFor = (
    kind: ForwardKind,
    rules: ForwardRule[],
  ): TableColumnProps<ForwardRule>[] => [
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
      title: kind === "local" ? "本地监听" : "远程监听",
      width: 145,
      render: (_, rule) => endpoint(rule.bindAddress, rule.bindPort),
    },
    {
      title: kind === "local" ? "远端目标" : "本地目标",
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
            changeRules(
              kind,
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
              onClick={() => openEditor(kind, rule)}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Popconfirm
            content={`删除端口转发“${rule.name}”？`}
            onOk={() =>
              changeRules(
                kind,
                rules.filter((item) => item.id !== rule.id),
              )
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

  const ruleTable = (kind: ForwardKind, rules: ForwardRule[]) => (
    <div className="port-forward-rule-list">
      <div className="port-forward-rules-toolbar">
        <Typography.Text type="secondary">
          {rules.length} 条规则
        </Typography.Text>
        <Button
          icon={<IconPlus />}
          onClick={() => openEditor(kind)}
          size="small"
          type="primary"
        >
          新增规则
        </Button>
      </div>
      <Table
        border={false}
        columns={columnsFor(kind, rules)}
        data={rules}
        noDataElement={<Empty description="暂无转发规则" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
    </div>
  );

  const editingKind = editing?.kind ?? activeKind;

  return (
    <div className="port-forward-rules-editor">
      <Tabs
        activeTab={activeKind}
        className="port-forward-kind-tabs"
        onChange={(key) => setActiveKind(key as ForwardKind)}
        size="small"
      >
        <Tabs.TabPane key="local" title={`本地转发 (${localRules.length})`}>
          {ruleTable("local", localRules)}
        </Tabs.TabPane>
        <Tabs.TabPane key="remote" title={`远程转发 (${remoteRules.length})`}>
          {ruleTable("remote", remoteRules)}
        </Tabs.TabPane>
      </Tabs>

      <Modal
        className="port-forward-rule-modal"
        footer={null}
        maskClosable={false}
        onCancel={() => setVisible(false)}
        style={{ width: 560 }}
        title={`${editing?.rule.name ? "编辑" : "新增"}${editingKind === "local" ? "本地" : "远程"}转发`}
        visible={visible}
      >
        <Form<ForwardRule>
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
            <Input autoFocus placeholder="例如：开发服务" />
          </Form.Item>
          <div className="port-forward-rule-row">
            <Form.Item
              field="bindAddress"
              label={editingKind === "local" ? "本地监听地址" : "远程监听地址"}
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
              label={editingKind === "local" ? "本地端口" : "远程端口"}
              rules={[{ required: true, message: "请输入监听端口" }]}
            >
              <InputNumber max={65535} min={1} mode="button" />
            </Form.Item>
          </div>
          <div className="port-forward-rule-row">
            <Form.Item
              field="targetAddress"
              label={editingKind === "local" ? "远端目标地址" : "本地目标地址"}
              rules={[{ required: true, message: "请输入目标地址" }]}
            >
              <Input
                placeholder={
                  editingKind === "local"
                    ? "服务器可访问的地址"
                    : "本机可访问的地址"
                }
              />
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
