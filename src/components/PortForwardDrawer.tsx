import { useMemo, useState } from "react";
import {
  Button,
  Drawer,
  Empty,
  Message,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconPause,
  IconPlayArrow,
} from "@arco-design/web-react/icon";
import { invoke } from "@tauri-apps/api/core";
import type {
  LocalPortForwardRule,
  PortForwardStatus,
  TerminalSession,
} from "../models";

interface PortForwardDrawerProps {
  session: TerminalSession;
  visible: boolean;
  onCancel: () => void;
  onStatusChange: (status: PortForwardStatus) => void;
}

function endpoint(address: string, port: number) {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

const STATUS_META = {
  active: { color: "green", label: "运行中" },
  stopped: { color: "gray", label: "已停止" },
  failed: { color: "red", label: "启动失败" },
} as const;

function PortForwardDrawer({
  session,
  visible,
  onCancel,
  onStatusChange,
}: PortForwardDrawerProps) {
  const [pendingRuleId, setPendingRuleId] = useState<string>();
  const rules = session.host.localPortForwards ?? [];
  const statusByRuleId = useMemo(
    () =>
      new Map(
        (session.portForwardStatuses ?? []).map((status) => [
          status.ruleId,
          status,
        ]),
      ),
    [session.portForwardStatuses],
  );
  const activeCount = rules.filter(
    (rule) => statusByRuleId.get(rule.id)?.status === "active",
  ).length;
  const connected = session.status === "connected";

  const changeRuntimeStatus = async (
    rule: LocalPortForwardRule,
    running: boolean,
  ) => {
    setPendingRuleId(rule.id);
    try {
      const status = running
        ? await invoke<PortForwardStatus>("ssh_stop_local_forward", {
            sessionId: session.id,
            ruleId: rule.id,
          })
        : await invoke<PortForwardStatus>("ssh_start_local_forward", {
            sessionId: session.id,
            rule,
          });
      onStatusChange(status);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setPendingRuleId(undefined);
    }
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
      width: 150,
      render: (_, rule) => endpoint(rule.bindAddress, rule.bindPort),
    },
    {
      title: "目标地址",
      width: 160,
      render: (_, rule) => endpoint(rule.targetAddress, rule.targetPort),
    },
    {
      title: "状态",
      width: 96,
      render: (_, rule) => {
        const status = statusByRuleId.get(rule.id) ?? {
          ruleId: rule.id,
          kind: "local" as const,
          status: "stopped" as const,
          bindAddress: rule.bindAddress,
          bindPort: rule.bindPort,
        };
        const meta = STATUS_META[status.status];
        const tag = <Tag color={meta.color}>{meta.label}</Tag>;
        return status.error ? (
          <Tooltip content={status.error}>{tag}</Tooltip>
        ) : (
          tag
        );
      },
    },
    {
      title: "操作",
      width: 64,
      render: (_, rule) => {
        const running = statusByRuleId.get(rule.id)?.status === "active";
        return (
          <Tooltip content={running ? "停止转发" : "启动转发"}>
            <Button
              aria-label={`${running ? "停止" : "启动"} ${rule.name}`}
              disabled={!connected}
              icon={running ? <IconPause /> : <IconPlayArrow />}
              loading={pendingRuleId === rule.id}
              onClick={() => void changeRuntimeStatus(rule, running)}
              size="mini"
              type="text"
            />
          </Tooltip>
        );
      },
    },
  ];

  return (
    <Drawer
      className="port-forward-drawer"
      footer={null}
      onCancel={onCancel}
      title="端口转发"
      visible={visible}
      width={720}
    >
      <div className="port-forward-runtime-summary">
        <Typography.Text type="secondary">
          本地端口转发通过当前 SSH 会话访问远端服务
        </Typography.Text>
        <Space size="mini">
          <Tag color={connected ? "green" : "gray"}>
            {connected ? "SSH 已连接" : "SSH 未连接"}
          </Tag>
          <Typography.Text type="secondary">
            {activeCount} / {rules.length} 运行中
          </Typography.Text>
        </Space>
      </div>
      <Table
        border={false}
        columns={columns}
        data={rules}
        noDataElement={<Empty description="暂无本地端口转发规则" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
    </Drawer>
  );
}

export default PortForwardDrawer;
