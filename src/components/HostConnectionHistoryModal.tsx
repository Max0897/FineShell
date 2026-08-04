import { useMemo, useState } from "react";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconLink } from "@arco-design/web-react/icon";
import type {
  ConnectionHistoryRecord,
  HostAuthMethod,
  ProxyRecord,
  QuickTarget,
  SshKeyRecord,
} from "../models";

export interface QuickConnectionRequest {
  authMethod: HostAuthMethod;
  password: string;
  proxyId?: string;
  sshKeyId?: string;
  target: QuickTarget;
}

interface HostConnectionHistoryModalProps {
  actionPending: boolean;
  history: ConnectionHistoryRecord[];
  loading: boolean;
  onCancel: () => void;
  onQuickConnect: (request: QuickConnectionRequest) => Promise<boolean>;
  onReconnect: (record: ConnectionHistoryRecord) => void;
  proxies: ProxyRecord[];
  sshKeys: SshKeyRecord[];
  visible: boolean;
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

export default function HostConnectionHistoryModal({
  actionPending,
  history,
  loading,
  onCancel,
  onQuickConnect,
  onReconnect,
  proxies,
  sshKeys,
  visible,
}: HostConnectionHistoryModalProps) {
  const [quickTarget, setQuickTarget] = useState<QuickTarget>({
    address: "",
    port: 22,
    username: "root",
  });
  const [quickPassword, setQuickPassword] = useState("");
  const [quickAuthMethod, setQuickAuthMethod] =
    useState<HostAuthMethod>("password");
  const [quickSshKeyId, setQuickSshKeyId] = useState<string>();
  const [quickProxyId, setQuickProxyId] = useState<string>();

  const credentialReady =
    quickAuthMethod === "password"
      ? Boolean(quickPassword)
      : quickAuthMethod === "privateKey"
        ? Boolean(quickSshKeyId)
        : true;
  const historyColumns = useMemo<
    TableColumnProps<ConnectionHistoryRecord>[]
  >(
    () => [
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
            disabled={actionPending}
            icon={<IconLink />}
            onClick={() => onReconnect(record)}
            size="mini"
            type="primary"
          >
            重连
          </Button>
        ),
      },
    ],
    [actionPending, onReconnect],
  );

  return (
    <Modal
      className="connection-history-modal"
      footer={null}
      onCancel={onCancel}
      title="连接历史"
      visible={visible}
    >
      <div className="connection-history-content">
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
                { label: "SSH Agent", value: "agent" },
              ]}
              value={quickAuthMethod}
            />
            {quickAuthMethod === "password" ? (
              <Input.Password
                onChange={setQuickPassword}
                placeholder="密码"
                value={quickPassword}
              />
            ) : quickAuthMethod === "privateKey" ? (
              <Select
                onChange={setQuickSshKeyId}
                options={sshKeys.map((sshKey) => ({
                  label: sshKey.name,
                  value: sshKey.id,
                }))}
                placeholder="选择私钥"
                value={quickSshKeyId}
              />
            ) : null}
            <InputNumber
              max={65535}
              min={1}
              onChange={(port) =>
                setQuickTarget((current) => ({ ...current, port }))
              }
              placeholder="端口"
              value={quickTarget.port}
            />
            <Select
              allowClear
              onChange={setQuickProxyId}
              options={proxies.map((proxy) => ({
                label: proxy.name,
                value: proxy.id,
              }))}
              placeholder="直连"
              value={quickProxyId}
            />
            <Button
              disabled={
                loading ||
                actionPending ||
                !quickTarget.address.trim() ||
                !credentialReady
              }
              icon={<IconLink />}
              onClick={() => {
                void onQuickConnect({
                  authMethod: quickAuthMethod,
                  password: quickPassword,
                  proxyId: quickProxyId,
                  sshKeyId: quickSshKeyId,
                  target: quickTarget,
                }).then((connected) => {
                  if (connected) setQuickPassword("");
                });
              }}
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
          loading={loading}
          noDataElement={<Empty description="暂无连接历史" />}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </div>
    </Modal>
  );
}
