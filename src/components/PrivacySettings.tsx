import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Message,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconDelete, IconRefresh } from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import type { AppSettings } from "../app-settings";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  clearConnectionHistory,
  loadConfiguration,
  removeCredentialReference,
  replaceCredentialReferences,
} from "../config-database";
import {
  buildCredentialCandidates,
  credentialKindLabel,
  orphanedCredentialReferences,
  reconcileCredentialReferences,
  type CredentialProbeResult,
  type CredentialReferenceRecord,
} from "../credential-registry";
import { emitProtocolEventTo } from "../tauri-protocol";

interface PrivacySettingsProps {
  savedSettings: AppSettings;
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function deleteNativeCredential(reference: CredentialReferenceRecord) {
  if (!isTauri()) return;
  switch (reference.kind) {
    case "hostPassword":
      await invoke("delete_host_password", { hostId: reference.ownerId });
      return;
    case "privateKeyPassphrase":
      await invoke("delete_private_key_passphrase", {
        hostId: reference.ownerId,
      });
      return;
    case "proxyPassword":
      await invoke("delete_proxy_password", { proxyId: reference.ownerId });
  }
}

function PrivacySettings({
  savedSettings,
  settings,
  updateSetting,
}: PrivacySettingsProps) {
  const [historyCount, setHistoryCount] = useState(0);
  const [orphaned, setOrphaned] = useState<CredentialReferenceRecord[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const scanCredentials = useCallback(async () => {
    const configuration = await loadConfiguration();
    setHistoryCount(configuration.history.length);
    if (!isTauri()) {
      setOrphaned([]);
      return;
    }

    setScanning(true);
    try {
      const candidates = buildCredentialCandidates(configuration);
      const probes = [
        ...new Map(
          [...configuration.credentialReferences, ...candidates].map((item) => [
            item.id,
            { kind: item.kind, ownerId: item.ownerId },
          ]),
        ).values(),
      ];
      const results = await invoke<CredentialProbeResult[]>(
        "inspect_credentials",
        { probes },
      );
      const reconciled = reconcileCredentialReferences(
        configuration.credentialReferences,
        candidates,
        results,
      );
      await replaceCredentialReferences(reconciled);
      setOrphaned(orphanedCredentialReferences(reconciled, candidates));
      setHasScanned(true);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void loadConfiguration()
      .then((configuration) => setHistoryCount(configuration.history.length))
      .catch((error) => Message.error(String(error)));
  }, [
    savedSettings.connectionHistoryLimit,
    savedSettings.connectionHistoryRetentionDays,
  ]);

  const clearHistory = async () => {
    try {
      await clearConnectionHistory();
      setHistoryCount(0);
      if (isTauri()) {
        await emitProtocolEventTo("main", "configuration:changed").catch(
          () => undefined,
        );
      }
      Message.success("连接历史已清空");
      setHasScanned(false);
      setOrphaned([]);
    } catch (error) {
      Message.error(String(error));
      throw error;
    }
  };

  const cleanCredential = async (reference: CredentialReferenceRecord) => {
    setCleaning(true);
    try {
      await deleteNativeCredential(reference);
      await removeCredentialReference(reference.kind, reference.ownerId);
      setOrphaned((current) =>
        current.filter((item) => item.id !== reference.id),
      );
      Message.success("遗留凭据已清理");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setCleaning(false);
    }
  };

  const cleanAllCredentials = async () => {
    setCleaning(true);
    try {
      for (const reference of orphaned) {
        await deleteNativeCredential(reference);
        await removeCredentialReference(reference.kind, reference.ownerId);
        setOrphaned((current) =>
          current.filter((item) => item.id !== reference.id),
        );
      }
      Message.success("遗留凭据已全部清理");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setCleaning(false);
    }
  };

  const columns = useMemo<TableColumnProps<CredentialReferenceRecord>[]>(
    () => [
      { title: "来源", dataIndex: "label" },
      {
        title: "类型",
        width: 120,
        render: (_, reference) => credentialKindLabel(reference.kind),
      },
      {
        title: "最近检查",
        width: 140,
        render: (_, reference) => formatTime(reference.updatedAt),
      },
      {
        title: "操作",
        width: 72,
        render: (_, reference) => (
          <Popconfirm
            content={`确定从系统凭据库中删除“${reference.label}”的${credentialKindLabel(reference.kind)}？`}
            onOk={() => cleanCredential(reference)}
          >
            <Button
              aria-label={`清理 ${reference.label}`}
              disabled={cleaning}
              icon={<IconDelete />}
              size="mini"
              status="danger"
            />
          </Popconfirm>
        ),
      },
    ],
    [cleaning],
  );

  return (
    <div className="privacy-settings">
      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>连接历史</Typography.Title>
            <Typography.Text type="secondary">
              当前保存 {historyCount} 条记录
            </Typography.Text>
          </div>
          <Popconfirm
            content="确定清空全部连接历史？此操作不会删除主机配置。"
            disabled={historyCount === 0}
            onOk={clearHistory}
          >
            <Button disabled={historyCount === 0} status="danger">
              清空历史
            </Button>
          </Popconfirm>
        </div>
        <div className="settings-group privacy-history-settings">
          <div className="settings-row">
            <Typography.Text>最多保留</Typography.Text>
            <div className="settings-control">
              <Select
                aria-label="连接历史数量"
                onChange={(value) =>
                  updateSetting(
                    "connectionHistoryLimit",
                    value as AppSettings["connectionHistoryLimit"],
                  )
                }
                options={[
                  { label: "20 条", value: 20 },
                  { label: "50 条", value: 50 },
                  { label: "100 条", value: 100 },
                  { label: "不限数量", value: 0 },
                ]}
                value={settings.connectionHistoryLimit}
              />
            </div>
          </div>
          <div className="settings-row">
            <Typography.Text>保留时间</Typography.Text>
            <div className="settings-control">
              <Select
                aria-label="连接历史保留时间"
                onChange={(value) =>
                  updateSetting(
                    "connectionHistoryRetentionDays",
                    value as AppSettings["connectionHistoryRetentionDays"],
                  )
                }
                options={[
                  { label: "7 天", value: 7 },
                  { label: "30 天", value: 30 },
                  { label: "90 天", value: 90 },
                  { label: "永久保留", value: 0 },
                ]}
                value={settings.connectionHistoryRetentionDays}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>系统凭据</Typography.Title>
            <Typography.Text type="secondary">
              检查不再被主机、密钥、代理或连接历史使用的凭据
            </Typography.Text>
          </div>
          <Space>
            <Button
              icon={<IconRefresh />}
              loading={scanning}
              onClick={() => void scanCredentials()}
            >
              重新扫描
            </Button>
            {orphaned.length > 0 && (
              <Popconfirm
                content={`确定清理检测到的 ${orphaned.length} 项遗留凭据？`}
                onOk={cleanAllCredentials}
              >
                <Button disabled={cleaning} status="danger">
                  全部清理
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        <Alert
          content="仅检查凭据是否存在及其关联关系，密码和密钥口令不会返回到界面或被显示。"
          type="info"
        />
        <Table
          className="credential-cleanup-table"
          columns={columns}
          data={orphaned}
          loading={scanning}
          noDataElement={
            <Empty
              description={
                hasScanned
                  ? "未发现可清理的遗留凭据"
                  : "点击重新扫描检查遗留凭据"
              }
            />
          }
          pagination={false}
          rowKey="id"
        />
      </section>
    </div>
  );
}

export default PrivacySettings;
