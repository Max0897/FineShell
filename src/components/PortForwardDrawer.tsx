import { useMemo, useState } from "react";
import {
  Button,
  Drawer,
  Empty,
  Message,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconPause,
  IconPlayArrow,
} from "@arco-design/web-react/icon";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  commandErrorMessage,
  type TauriCommand,
} from "../tauri-protocol";
import type {
  DynamicPortForwardRule,
  LocalPortForwardRule,
  PortForwardStatus,
  RemotePortForwardRule,
  TerminalSession,
} from "../models";

type ForwardKind = "local" | "remote" | "dynamic";
type RuntimeForwardRule = (
  | LocalPortForwardRule
  | RemotePortForwardRule
  | DynamicPortForwardRule
) & {
  kind: ForwardKind;
};

interface PortForwardDrawerProps {
  session: TerminalSession;
  visible: boolean;
  onCancel: () => void;
  onStatusChange: (status: PortForwardStatus) => void;
}

function endpoint(address: string, port: number) {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function statusKey(kind: ForwardKind, ruleId: string) {
  return `${kind}:${ruleId}`;
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
  const [activeKind, setActiveKind] = useState<ForwardKind>("local");
  const [pendingRuleKey, setPendingRuleKey] = useState<string>();
  const localRules = useMemo<RuntimeForwardRule[]>(
    () =>
      (session.host.localPortForwards ?? []).map((rule) => ({
        ...rule,
        kind: "local",
      })),
    [session.host.localPortForwards],
  );
  const remoteRules = useMemo<RuntimeForwardRule[]>(
    () =>
      (session.host.remotePortForwards ?? []).map((rule) => ({
        ...rule,
        kind: "remote",
      })),
    [session.host.remotePortForwards],
  );
  const dynamicRules = useMemo<RuntimeForwardRule[]>(
    () =>
      (session.host.dynamicPortForwards ?? []).map((rule) => ({
        ...rule,
        kind: "dynamic",
      })),
    [session.host.dynamicPortForwards],
  );
  const rules =
    activeKind === "local"
      ? localRules
      : activeKind === "remote"
        ? remoteRules
        : dynamicRules;
  const statusByRuleKey = useMemo(
    () =>
      new Map(
        (session.portForwardStatuses ?? []).map((status) => [
          statusKey(status.kind, status.ruleId),
          status,
        ]),
      ),
    [session.portForwardStatuses],
  );
  const connected = session.status === "connected";

  const changeRuntimeStatus = async (
    rule: RuntimeForwardRule,
    running: boolean,
  ) => {
    const key = statusKey(rule.kind, rule.id);
    setPendingRuleKey(key);
    try {
      const command: TauriCommand = running
        ? {
            local: "ssh_stop_local_forward",
            remote: "ssh_stop_remote_forward",
            dynamic: "ssh_stop_dynamic_forward",
          }[rule.kind] as TauriCommand
        : {
            local: "ssh_start_local_forward",
            remote: "ssh_start_remote_forward",
            dynamic: "ssh_start_dynamic_forward",
          }[rule.kind] as TauriCommand;
      const status = running
        ? await invoke<PortForwardStatus>(command, {
            sessionId: session.id,
            ruleId: rule.id,
          })
        : await invoke<PortForwardStatus>(command, {
            sessionId: session.id,
            rule,
          });
      onStatusChange(status);
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setPendingRuleKey(undefined);
    }
  };

  const columns: TableColumnProps<RuntimeForwardRule>[] = [
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
      title:
        activeKind === "remote"
          ? "远程监听"
          : activeKind === "dynamic"
            ? "SOCKS5 监听"
            : "本地监听",
      width: 150,
      render: (_, rule) => endpoint(rule.bindAddress, rule.bindPort),
    },
    ...(activeKind === "dynamic"
      ? []
      : [
          {
            title: activeKind === "local" ? "远端目标" : "本地目标",
            width: 160,
            render: (_: unknown, rule: RuntimeForwardRule) =>
              "targetAddress" in rule
                ? endpoint(rule.targetAddress, rule.targetPort)
                : "-",
          },
        ]),
    {
      title: "状态",
      width: 96,
      render: (_, rule) => {
        const status = statusByRuleKey.get(
          statusKey(rule.kind, rule.id),
        ) ?? {
          ruleId: rule.id,
          kind: rule.kind,
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
        const key = statusKey(rule.kind, rule.id);
        const running = statusByRuleKey.get(key)?.status === "active";
        return (
          <Tooltip content={running ? "停止转发" : "启动转发"}>
            <Button
              aria-label={`${running ? "停止" : "启动"} ${rule.name}`}
              disabled={!connected}
              icon={running ? <IconPause /> : <IconPlayArrow />}
              loading={pendingRuleKey === key}
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
      <Tabs
        activeTab={activeKind}
        className="port-forward-runtime-tabs"
        onChange={(key) => setActiveKind(key as ForwardKind)}
        size="small"
      >
        <Tabs.TabPane key="local" title={`本地转发 (${localRules.length})`} />
        <Tabs.TabPane key="remote" title={`远程转发 (${remoteRules.length})`} />
        <Tabs.TabPane key="dynamic" title={`动态转发 (${dynamicRules.length})`} />
      </Tabs>
      <Table
        border={false}
        columns={columns}
        data={rules}
        noDataElement={
          <Empty
            description={`暂无${
              activeKind === "local"
                ? "本地"
                : activeKind === "remote"
                  ? "远程"
                  : "动态"
            }端口转发规则`}
          />
        }
        pagination={false}
        rowKey={(rule) => statusKey(rule.kind, rule.id)}
        size="small"
      />
    </Drawer>
  );
}

export default PortForwardDrawer;
