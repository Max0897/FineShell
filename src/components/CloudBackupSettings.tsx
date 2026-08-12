import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconCloud,
  IconDelete,
  IconRefresh,
  IconSafe,
  IconUpload,
} from "@arco-design/web-react/icon";
import { getVersion } from "@tauri-apps/api/app";
import type { AppSettings } from "../app-settings";
import {
  applyCloudBackupCredentials,
  cloudBackupCredentialStatus,
  createCloudBackupSnapshot,
  deleteCloudBackupSnapshot,
  discardCloudBackupRestore,
  downloadCloudBackupSnapshot,
  initializeCloudBackupRepository,
  listCloudBackupSnapshots,
  loadCloudBackupSettings,
  readCloudBackupRepository,
  saveCloudBackupSettings,
  storeCloudBackupCredentials,
  testCloudBackupConnection,
  unlockCloudBackupRepository,
  type CloudBackupProtectionMode,
  type CloudBackupRepositoryStatus,
  type CloudBackupSettings as StoredCloudBackupSettings,
  type CloudBackupSnapshot,
} from "../cloud-backup";
import {
  loadConfiguration,
  parseConfigurationExport,
  serializeConfigurationExport,
} from "../config-database";
import {
  importConfiguration,
  restoreCredentialReferences,
} from "../configuration-mutations";
import { emitProtocolEventTo } from "../tauri-protocol";

interface CloudBackupSettingsProps {
  onConfigurationImported?: (settings: AppSettings) => void;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value || "-"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function protectionLabel(mode?: CloudBackupProtectionMode) {
  switch (mode) {
    case "password":
      return "备份密码";
    case "recoveryKey":
      return "恢复密钥";
    case "none":
      return "不加密";
    default:
      return "-";
  }
}

function CloudBackupSettings({
  onConfigurationImported,
}: CloudBackupSettingsProps) {
  const [settings, setSettings] = useState(loadCloudBackupSettings);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [password, setPassword] = useState("");
  const [unlockSecret, setUnlockSecret] = useState("");
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [repository, setRepository] = useState<CloudBackupRepositoryStatus>();
  const [snapshots, setSnapshots] = useState<CloudBackupSnapshot[]>([]);
  const [acting, setActing] = useState(false);
  const [loading, setLoading] = useState(true);

  const effectiveProtection =
    repository?.protectionMode ?? settings.protectionMode;
  const canIncludeCredentials = effectiveProtection !== "none";

  const updateStorage = useCallback(
    <K extends keyof StoredCloudBackupSettings["storage"]>(
      key: K,
      value: StoredCloudBackupSettings["storage"][K],
    ) => {
      setSettings((current) => ({
        ...current,
        storage: { ...current.storage, [key]: value },
      }));
      setRepository(undefined);
      setSnapshots([]);
    },
    [],
  );

  const refreshSnapshots = useCallback(
    async (status?: CloudBackupRepositoryStatus) => {
      const activeStatus = status ?? repository;
      if (!activeStatus?.exists || !activeStatus.unlocked) {
        setSnapshots([]);
        return;
      }
      setSnapshots(await listCloudBackupSnapshots(settings.storage));
    },
    [repository, settings.storage],
  );

  const refreshRepository = useCallback(async () => {
    const status = await readCloudBackupRepository(settings.storage);
    setRepository(status);
    setCredentialConfigured(status.credentialConfigured);
    await refreshSnapshots(status);
    return status;
  }, [refreshSnapshots, settings.storage]);

  useEffect(() => {
    let disposed = false;
    void cloudBackupCredentialStatus(settings.storage.profileId)
      .then((configured) => {
        if (!disposed) setCredentialConfigured(configured);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [settings.storage.profileId]);

  const saveConnection = async () => {
    const saved = saveCloudBackupSettings(settings);
    setSettings(saved);
    if (accessKeyId.trim() || secretAccessKey) {
      await storeCloudBackupCredentials(
        saved.storage.profileId,
        accessKeyId,
        secretAccessKey,
      );
      setCredentialConfigured(true);
      setAccessKeyId("");
      setSecretAccessKey("");
    } else if (!credentialConfigured) {
      throw new Error("请填写 Access Key 和 Secret Key");
    }
    return saved;
  };

  const testConnection = async () => {
    setActing(true);
    try {
      const saved = await saveConnection();
      await testCloudBackupConnection(saved.storage);
      Message.success("S3 连接和写入权限正常");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const connectRepository = async () => {
    setActing(true);
    try {
      await saveConnection();
      const status = await refreshRepository();
      Message.success(
        status.exists ? "已读取云备份仓库" : "连接成功，可以初始化仓库",
      );
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const initializeRepository = async () => {
    setActing(true);
    try {
      const saved = saveCloudBackupSettings({
        ...settings,
        includeCredentials:
          settings.protectionMode === "none"
            ? false
            : settings.includeCredentials,
      });
      setSettings(saved);
      const result = await initializeCloudBackupRepository(
        saved.storage,
        saved.protectionMode,
        saved.protectionMode === "password" ? password : undefined,
      );
      setPassword("");
      if (result.recoveryKey) {
        Modal.info({
          closable: false,
          content: (
            <div className="cloud-backup-recovery-key">
              <Typography.Paragraph>
                这是解锁云备份的唯一恢复密钥。FineShell
                不会上传或再次显示它，请立即保存到安全位置。
              </Typography.Paragraph>
              <Typography.Paragraph copyable code>
                {result.recoveryKey}
              </Typography.Paragraph>
            </div>
          ),
          okText: "我已保存",
          title: "保存恢复密钥",
        });
      }
      await refreshRepository();
      Message.success("云备份仓库已初始化");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const unlockRepository = async () => {
    setActing(true);
    try {
      await unlockCloudBackupRepository(settings.storage, unlockSecret);
      setUnlockSecret("");
      await refreshRepository();
      Message.success("云备份仓库已解锁");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const createSnapshot = async () => {
    setActing(true);
    try {
      const saved = saveCloudBackupSettings({
        ...settings,
        includeCredentials: canIncludeCredentials
          ? settings.includeCredentials
          : false,
      });
      setSettings(saved);
      const configuration = await loadConfiguration();
      const appVersion = await getVersion();
      await createCloudBackupSnapshot({
        storage: saved.storage,
        configuration: serializeConfigurationExport(configuration),
        credentialReferences: configuration.credentialReferences,
        includeCredentials: saved.includeCredentials,
        deviceName: navigator.platform || "FineShell",
        appVersion,
        retentionCount: saved.retentionCount,
      });
      await refreshSnapshots(repository);
      Message.success("云备份已创建");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const restoreSnapshot = async (snapshot: CloudBackupSnapshot) => {
    setActing(true);
    let pendingRestoreToken: string | undefined;
    try {
      const downloaded = await downloadCloudBackupSnapshot(
        settings.storage,
        snapshot.key,
      );
      pendingRestoreToken = downloaded.restoreToken;
      const imported = parseConfigurationExport(downloaded.configuration);
      Modal.confirm({
        content: (
          <Descriptions
            border
            column={1}
            data={[
              { label: "创建时间", value: formatTime(downloaded.createdAt) },
              { label: "来源设备", value: downloaded.deviceName || "未知" },
              { label: "应用版本", value: downloaded.appVersion || "未知" },
              {
                label: "系统凭据",
                value: downloaded.credentialCount
                  ? `${downloaded.credentialCount} 项，将写入当前设备凭据库`
                  : "不包含",
              },
            ]}
          />
        ),
        onOk: async () => {
          const configuration = await importConfiguration(imported);
          if (downloaded.restoreToken) {
            await applyCloudBackupCredentials(downloaded.restoreToken);
            pendingRestoreToken = undefined;
            await restoreCredentialReferences(downloaded.credentialReferences);
          }
          onConfigurationImported?.(configuration.settings);
          await Promise.allSettled([
            emitProtocolEventTo("main", "configuration:changed"),
            emitProtocolEventTo(
              "main",
              "settings:changed",
              configuration.settings,
            ),
          ]);
          Message.success("云备份已恢复");
        },
        onCancel: () => {
          if (downloaded.restoreToken) {
            void discardCloudBackupRestore(downloaded.restoreToken);
            pendingRestoreToken = undefined;
          }
        },
        okText: "恢复",
        title: "恢复此云备份？",
        unmountOnExit: false,
      });
    } catch (error) {
      if (pendingRestoreToken) {
        await discardCloudBackupRestore(pendingRestoreToken).catch(
          () => undefined,
        );
      }
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeSnapshot = async (snapshot: CloudBackupSnapshot) => {
    setActing(true);
    try {
      await deleteCloudBackupSnapshot(settings.storage, snapshot.key);
      await refreshSnapshots(repository);
      Message.success("云备份已删除");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns: TableColumnProps<CloudBackupSnapshot>[] = [
    {
      dataIndex: "createdAt",
      render: (value: string) => formatTime(value),
      title: "创建时间",
    },
    {
      dataIndex: "size",
      render: (value: number) => formatBytes(value),
      title: "大小",
      width: 110,
    },
    {
      render: (_, snapshot) => (
        <Space>
          <Button
            disabled={acting}
            onClick={() => void restoreSnapshot(snapshot)}
            size="small"
            type="text"
          >
            恢复
          </Button>
          <Popconfirm
            onOk={() => removeSnapshot(snapshot)}
            title="删除此云备份？"
            unmountOnExit={false}
          >
            <Button
              aria-label="删除云备份"
              disabled={acting}
              icon={<IconDelete />}
              size="small"
              status="danger"
              type="text"
            />
          </Popconfirm>
        </Space>
      ),
      title: "操作",
      width: 130,
    },
  ];

  return (
    <div className="cloud-backup-settings">
      <section className="cloud-backup-section">
        <div className="cloud-backup-section-heading">
          <div>
            <Typography.Title heading={6}>S3 存储</Typography.Title>
            <Typography.Text type="secondary">
              支持 Cloudflare R2、MinIO、阿里云 OSS 等具有自定义 Endpoint
              的 S3 兼容服务。
            </Typography.Text>
          </div>
          <Space>
            <Button
              disabled={acting || loading}
              loading={acting}
              onClick={() => void testConnection()}
            >
              测试连接
            </Button>
            <Button
              disabled={acting || loading}
              icon={<IconCloud />}
              onClick={() => void connectRepository()}
              type="primary"
            >
              连接仓库
            </Button>
          </Space>
        </div>
        <div className="cloud-backup-form-grid">
          <label>
            <span>Endpoint</span>
            <Input
              onChange={(value) => updateStorage("endpoint", value)}
              placeholder="https://s3.example.com"
              value={settings.storage.endpoint}
            />
          </label>
          <label>
            <span>区域</span>
            <Input
              onChange={(value) => updateStorage("region", value)}
              value={settings.storage.region}
            />
          </label>
          <label>
            <span>Bucket</span>
            <Input
              onChange={(value) => updateStorage("bucket", value)}
              placeholder="fineshell-backup"
              value={settings.storage.bucket}
            />
          </label>
          <label>
            <span>路径前缀</span>
            <Input
              onChange={(value) => updateStorage("prefix", value)}
              placeholder="FineShell"
              value={settings.storage.prefix}
            />
          </label>
          <label>
            <span>Access Key</span>
            <Input
              onChange={setAccessKeyId}
              placeholder={
                credentialConfigured ? "已保存，留空保持不变" : "Access Key ID"
              }
              value={accessKeyId}
            />
          </label>
          <label>
            <span>Secret Key</span>
            <Input.Password
              onChange={setSecretAccessKey}
              placeholder={
                credentialConfigured
                  ? "已保存，留空保持不变"
                  : "Secret Access Key"
              }
              value={secretAccessKey}
            />
          </label>
        </div>
      </section>

      {repository && (
        <section className="cloud-backup-section">
          <div className="cloud-backup-section-heading">
            <div>
              <Typography.Title heading={6}>备份仓库</Typography.Title>
              <Typography.Text type="secondary">
                {repository.exists
                  ? `${protectionLabel(repository.protectionMode)} · ${repository.unlocked ? "已解锁" : "已锁定"}`
                  : "当前路径尚未初始化"}
              </Typography.Text>
            </div>
            {repository.exists && repository.unlocked && (
              <Button
                disabled={acting}
                icon={<IconRefresh />}
                onClick={() => void refreshSnapshots(repository)}
              >
                刷新
              </Button>
            )}
          </div>

          {!repository.exists ? (
            <div className="cloud-backup-initialize">
              <Radio.Group
                direction="vertical"
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    protectionMode: value,
                    includeCredentials:
                      value === "none" ? false : current.includeCredentials,
                  }))
                }
                value={settings.protectionMode}
              >
                <Radio value="password">
                  备份密码：在每台新设备输入同一密码
                </Radio>
                <Radio value="recoveryKey">
                  恢复密钥：首次生成一次，适合密码管理器保存
                </Radio>
                <Radio value="none">不加密：仅备份配置，禁止包含主机凭据</Radio>
              </Radio.Group>
              {settings.protectionMode === "password" && (
                <Input.Password
                  onChange={setPassword}
                  placeholder="至少 8 个字符，不会上传到云端"
                  value={password}
                />
              )}
              <Button
                disabled={acting}
                icon={<IconSafe />}
                onClick={() => void initializeRepository()}
                type="primary"
              >
                初始化仓库
              </Button>
            </div>
          ) : !repository.unlocked ? (
            <div className="cloud-backup-unlock">
              <Alert
                content={`请输入${repository.protectionMode === "recoveryKey" ? "恢复密钥" : "备份密码"}。解锁后的主密钥仅保存在当前设备系统凭据库。`}
                type="info"
              />
              <Space>
                <Input.Password
                  onChange={setUnlockSecret}
                  placeholder={
                    repository.protectionMode === "recoveryKey"
                      ? "恢复密钥"
                      : "备份密码"
                  }
                  value={unlockSecret}
                />
                <Button
                  disabled={acting || !unlockSecret}
                  onClick={() => void unlockRepository()}
                  type="primary"
                >
                  解锁
                </Button>
              </Space>
            </div>
          ) : (
            <>
              <div className="cloud-backup-options">
                <Checkbox
                  checked={canIncludeCredentials && settings.includeCredentials}
                  disabled={!canIncludeCredentials}
                  onChange={(value) =>
                    setSettings((current) => ({
                      ...current,
                      includeCredentials: value,
                    }))
                  }
                >
                  包含主机密码、代理密码和私钥口令
                </Checkbox>
                <Space>
                  <Typography.Text>保留最近</Typography.Text>
                  <InputNumber
                    max={100}
                    min={1}
                    onChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        retentionCount: value,
                      }))
                    }
                    value={settings.retentionCount}
                  />
                  <Typography.Text>份</Typography.Text>
                </Space>
                <Button
                  disabled={acting}
                  icon={<IconUpload />}
                  loading={acting}
                  onClick={() => void createSnapshot()}
                  type="primary"
                >
                  立即备份
                </Button>
              </div>
              <Table
                border={false}
                columns={columns}
                data={snapshots}
                loading={acting}
                pagination={false}
                rowKey="key"
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}

export default CloudBackupSettings;
