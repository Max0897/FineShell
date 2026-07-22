import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Empty,
  Message,
  Popconfirm,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconDelete, IconUndo } from "@arco-design/web-react/icon";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  type ConfigurationBackup,
  type DeletedHostRecord,
  loadConfiguration,
  permanentlyDeleteHost,
  purgeExpiredDeletedHosts,
  restoreConfigurationBackup,
  restoreDeletedHost,
} from "../config-database";

interface ConfigurationMaintenanceProps {
  section: "backups" | "trash";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function removeHostCredentials(hostId: string) {
  if (!isTauri()) return [];
  return Promise.allSettled([
    invoke("delete_host_password", { hostId }),
    invoke("delete_private_key_passphrase", { hostId }),
  ]);
}

async function notifyHostManager() {
  if (!isTauri()) return;
  await emitTo("host-manager", "configuration:changed").catch(() => undefined);
}

function ConfigurationMaintenance({
  section,
}: ConfigurationMaintenanceProps) {
  const [backups, setBackups] = useState<ConfigurationBackup[]>([]);
  const [trash, setTrash] = useState<DeletedHostRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setBackups(configuration.backups);
    setTrash(configuration.trash);
  }, []);

  useEffect(() => {
    let disposed = false;
    void purgeExpiredDeletedHosts()
      .then(async ({ configuration, expiredHostIds }) => {
        if (disposed) return;
        setBackups(configuration.backups);
        setTrash(configuration.trash);
        const cleanup = await Promise.allSettled(
          expiredHostIds.map((hostId) => removeHostCredentials(hostId)),
        );
        if (
          !disposed &&
          cleanup.some(
            (group) =>
              group.status === "rejected" ||
              group.value.some((result) => result.status === "rejected"),
          )
        ) {
          Message.warning("过期主机已清理，但部分系统凭据删除失败");
        }
      })
      .catch((error) => {
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("configuration:changed", () => {
      void refresh().catch((error) => Message.error(String(error)));
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const restoreBackup = async (backup: ConfigurationBackup) => {
    setActing(true);
    try {
      const configuration = await restoreConfigurationBackup(backup.id);
      setBackups(configuration.backups);
      setTrash(configuration.trash);
      await notifyHostManager();
      Message.success("配置已恢复");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setActing(false);
    }
  };

  const restoreTrashedHost = async (deletedHost: DeletedHostRecord) => {
    setActing(true);
    try {
      const configuration = await restoreDeletedHost(deletedHost.id);
      setBackups(configuration.backups);
      setTrash(configuration.trash);
      await notifyHostManager();
      Message.success(`已恢复 ${deletedHost.host.name}`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const permanentlyDeleteTrashedHost = async (
    deletedHost: DeletedHostRecord,
  ) => {
    setActing(true);
    try {
      const configuration = await permanentlyDeleteHost(deletedHost.id);
      setTrash(configuration.trash);
      const hostIdIsActive = configuration.hosts.some(
        (host) => host.id === deletedHost.host.id,
      );
      const cleanup = hostIdIsActive
        ? []
        : await removeHostCredentials(deletedHost.host.id);
      if (cleanup.some((result) => result.status === "rejected")) {
        Message.warning("主机已永久删除，但部分系统凭据清理失败");
      } else {
        Message.success(`已永久删除 ${deletedHost.host.name}`);
      }
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setActing(false);
    }
  };

  const backupColumns: TableColumnProps<ConfigurationBackup>[] = [
    {
      title: "备份时间",
      dataIndex: "createdAt",
      width: 150,
      render: (value) => formatTime(value),
    },
    { title: "原因", dataIndex: "reason" },
    {
      title: "内容",
      width: 150,
      render: (_, backup) =>
        `${backup.hosts.length} 台主机，${backup.history.length} 条记录`,
    },
    {
      title: "操作",
      width: 90,
      render: (_, backup) => (
        <Popconfirm
          onOk={() => restoreBackup(backup)}
          position="top"
          title="恢复后当前配置会自动备份，是否继续？"
          unmountOnExit={false}
        >
          <Button
            disabled={acting}
            icon={<IconUndo />}
            size="mini"
          >
            恢复
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const trashColumns: TableColumnProps<DeletedHostRecord>[] = [
    {
      title: "主机",
      render: (_, deletedHost) => (
        <div className="host-name-cell">
          <Typography.Text bold>{deletedHost.host.name}</Typography.Text>
          <Typography.Text type="secondary">
            {deletedHost.host.username}@{deletedHost.host.address}:
            {deletedHost.host.port}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "保留期限",
      width: 180,
      render: (_, deletedHost) => (
        <div className="configuration-retention-cell">
          <Typography.Text type="secondary">
            删除：{formatTime(deletedHost.deletedAt)}
          </Typography.Text>
          <Typography.Text type="secondary">
            清理：{formatTime(deletedHost.expiresAt)}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "操作",
      width: 90,
      render: (_, deletedHost) => (
        <Space size="mini">
          <Button
            aria-label={`恢复 ${deletedHost.host.name}`}
            disabled={acting}
            icon={<IconUndo />}
            onClick={() => void restoreTrashedHost(deletedHost)}
            size="mini"
          />
          <Popconfirm
            onOk={() => permanentlyDeleteTrashedHost(deletedHost)}
            position="top"
            title={`永久删除“${deletedHost.host.name}”及其系统凭据？`}
            unmountOnExit={false}
          >
            <Button
              aria-label={`永久删除 ${deletedHost.host.name}`}
              disabled={acting}
              icon={<IconDelete />}
              size="mini"
              status="danger"
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Typography.Title heading={5}>
        {section === "backups" ? "备份与恢复" : "回收站"}
      </Typography.Title>
      {section === "backups" ? (
        <Table<ConfigurationBackup>
          border={false}
          columns={backupColumns}
          data={backups}
          loading={loading || acting}
          noDataElement={<Empty description="暂无自动备份" />}
          pagination={false}
          rowKey="id"
          size="small"
        />
      ) : (
        <Table<DeletedHostRecord>
          border={false}
          columns={trashColumns}
          data={trash}
          loading={loading || acting}
          noDataElement={<Empty description="回收站为空" />}
          pagination={false}
          rowKey="id"
          size="small"
        />
      )}
    </>
  );
}

export default ConfigurationMaintenance;
