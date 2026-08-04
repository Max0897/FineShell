import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Input,
  Message,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconCopy, IconDelete, IconSearch } from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  loadConfiguration,
} from "../config-database";
import { removeKnownHostFingerprints } from "../configuration-mutations";
import { knownHostTargetKey } from "../known-hosts";
import type { HostRecord, KnownHostRecord } from "../models";
import {
  emitProtocolEventTo,
  listenProtocolEvent,
} from "../tauri-protocol";

interface KnownHostView extends KnownHostRecord {
  linkedHostNames: string[];
}

function formatEndpoint(address: string, port: number) {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function copyText(value: string) {
  if (isTauri()) {
    await writeClipboardText(value);
    return;
  }
  if (!navigator.clipboard) throw new Error("当前环境无法写入剪贴板");
  await navigator.clipboard.writeText(value);
}

function KnownHostSettings() {
  const [knownHosts, setKnownHosts] = useState<KnownHostRecord[]>([]);
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setKnownHosts(configuration.knownHosts);
    setHosts(configuration.hosts);
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

  const records = useMemo<KnownHostView[]>(
    () =>
      knownHosts.map((record) => {
        const targetKey = knownHostTargetKey(record.address, record.port);
        return {
          ...record,
          linkedHostNames: hosts
            .filter(
              (host) =>
                knownHostTargetKey(host.address, host.port) === targetKey,
            )
            .map((host) => host.name),
        };
      }),
    [hosts, knownHosts],
  );

  const filteredRecords = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return records;
    return records.filter((record) =>
      [
        record.address,
        String(record.port),
        record.fingerprint,
        ...record.linkedHostNames,
      ].some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [query, records]);

  const unlinkedIds = useMemo(
    () =>
      records
        .filter((record) => record.linkedHostNames.length === 0)
        .map((record) => record.id),
    [records],
  );

  async function notifyConfigurationChanged() {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(
      () => undefined,
    );
  }

  async function removeRecords(ids: string[], successMessage: string) {
    setActing(true);
    try {
      const configuration = await removeKnownHostFingerprints(ids);
      setKnownHosts(configuration.knownHosts);
      setHosts(configuration.hosts);
      await notifyConfigurationChanged();
      Message.success(successMessage);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  }

  async function copyFingerprint(record: KnownHostRecord) {
    try {
      await copyText(record.fingerprint);
      Message.success("指纹已复制");
    } catch (error) {
      Message.error(String(error));
    }
  }

  const columns = useMemo<TableColumnProps<KnownHostView>[]>(
    () => [
      {
        title: "主机",
        width: 180,
        render: (_, record) => (
          <div className="known-host-target-cell">
            <Typography.Text
              bold
              title={formatEndpoint(record.address, record.port)}
            >
              {formatEndpoint(record.address, record.port)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {record.linkedHostNames.length
                ? record.linkedHostNames.join("、")
                : "未关联已保存主机"}
            </Typography.Text>
          </div>
        ),
      },
      {
        title: "SHA256 指纹",
        render: (_, record) => (
          <div className="known-host-fingerprint-cell">
            <Typography.Text title={record.fingerprint}>
              {record.fingerprint}
            </Typography.Text>
            <Typography.Text
              title={`首次 ${formatTimestamp(record.firstSeenAt)} · 最近验证 ${formatTimestamp(record.lastVerifiedAt)}`}
              type="secondary"
            >
              首次 {formatTimestamp(record.firstSeenAt)} · 最近验证{" "}
              {formatTimestamp(record.lastVerifiedAt)}
            </Typography.Text>
          </div>
        ),
      },
      {
        title: "操作",
        width: 82,
        render: (_, record) => (
          <Space size="mini">
            <Tooltip content="复制指纹">
              <Button
                aria-label={`复制 ${formatEndpoint(record.address, record.port)} 指纹`}
                icon={<IconCopy />}
                onClick={() => void copyFingerprint(record)}
                size="mini"
              />
            </Tooltip>
            <Popconfirm
              content="移除后，下次连接该服务器时需要重新确认指纹。"
              disabled={acting}
              onOk={() =>
                void removeRecords([record.id], "已移除已知主机记录")
              }
              title={`移除 ${formatEndpoint(record.address, record.port)}？`}
            >
              <Button
                aria-label={`移除 ${formatEndpoint(record.address, record.port)} 指纹`}
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
    [acting],
  );

  return (
    <div className="known-host-settings">
      <div className="known-host-settings-heading">
        <div>
          <Typography.Text type="secondary">
            移除记录后，该服务器会在下次连接时重新请求指纹确认。
          </Typography.Text>
        </div>
        <Popconfirm
          content="未关联记录包含通过快速连接保存、但没有对应主机配置的指纹。"
          disabled={acting || unlinkedIds.length === 0}
          onOk={() =>
            void removeRecords(unlinkedIds, "已清理未关联的已知主机记录")
          }
          title={`清理 ${unlinkedIds.length} 条未关联记录？`}
        >
          <Button
            disabled={acting || unlinkedIds.length === 0}
            icon={<IconDelete />}
          >
            清理未关联
          </Button>
        </Popconfirm>
      </div>
      <Input
        allowClear
        aria-label="搜索已知主机"
        className="known-host-search"
        onChange={setQuery}
        placeholder="搜索地址、端口、主机名称或指纹"
        prefix={<IconSearch />}
        value={query}
      />
      <Table
        border={false}
        columns={columns}
        data={filteredRecords}
        loading={loading}
        noDataElement={<Empty description="暂无已知主机" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
    </div>
  );
}

export default KnownHostSettings;
