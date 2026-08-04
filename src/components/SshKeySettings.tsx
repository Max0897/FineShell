import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconFolder,
  IconPlus,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  loadConfiguration,
} from "../config-database";
import {
  deleteSshKey,
  removeCredentialReference,
  upsertCredentialReference,
  upsertSshKey,
} from "../configuration-mutations";
import { createCredentialReference } from "../credential-registry";
import type {
  SshKeyFormValues,
  SshKeyRecord,
  SshKeySource,
} from "../models";
import { getSshKeySource } from "../ssh-keys";
import {
  emitProtocolEventTo,
  listenProtocolEvent,
} from "../tauri-protocol";

function createSshKeyId() {
  return `ssh-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function choosePrivateKeyPath() {
  if (!isTauri()) return undefined;
  const selected = await open({
    directory: false,
    multiple: false,
    title: "选择 SSH 私钥",
  });
  return typeof selected === "string" ? selected : undefined;
}

async function storePassphrase(sshKeyId: string, passphrase: string) {
  if (!isTauri()) return;
  await invoke("store_private_key_passphrase", {
    hostId: sshKeyId,
    passphrase,
  });
}

async function removePassphrase(sshKeyId: string) {
  if (isTauri()) {
    await invoke("delete_private_key_passphrase", { hostId: sshKeyId });
  }
  await removeCredentialReference("privateKeyPassphrase", sshKeyId);
}

interface ManagedSshKeyImportResult {
  reference: string;
  keyType: string;
}

async function importManagedSshKey(sshKeyId: string, privateKey: string) {
  if (!isTauri()) {
    throw new Error("粘贴私钥仅在桌面应用中可用");
  }
  return invoke<ManagedSshKeyImportResult>("managed_ssh_key_import", {
    keyId: sshKeyId,
    privateKey,
  });
}

async function deleteManagedSshKey(sshKeyId: string) {
  if (!isTauri()) return;
  await invoke("managed_ssh_key_delete", { keyId: sshKeyId });
}

interface SshKeyEditorModalProps {
  sshKey: SshKeyRecord | null;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: SshKeyFormValues) => void;
}

function SshKeyEditorModal({
  sshKey,
  visible,
  onCancel,
  onSubmit,
}: SshKeyEditorModalProps) {
  const [form] = Form.useForm<SshKeyFormValues>();
  const initialSource = sshKey ? getSshKeySource(sshKey) : "file";
  const [source, setSource] = useState<SshKeySource>(initialSource);

  return (
    <Modal
      className="ssh-key-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 620 }}
      title={sshKey ? "编辑密钥" : "新增密钥"}
      visible={visible}
    >
      <Form<SshKeyFormValues>
        form={form}
        initialValues={{
          name: sshKey?.name ?? "",
          source: initialSource,
          privateKeyPath: sshKey?.privateKeyPath ?? "",
          privateKeyContent: "",
          passphrase: "",
        }}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <Form.Item
          field="name"
          label="名称"
          rules={[{ required: true, message: "请输入密钥名称" }]}
        >
          <Input autoFocus placeholder="例如：生产环境 Ed25519" />
        </Form.Item>
        <Form.Item field="source" label="添加方式">
          <Radio.Group
            disabled={Boolean(sshKey)}
            onChange={(value) => setSource(value as SshKeySource)}
            options={[
              { label: "选择文件", value: "file" },
              { label: "粘贴私钥", value: "managed" },
            ]}
            type="button"
          />
        </Form.Item>
        {source === "file" ? (
          <Form.Item
            field="privateKeyPath"
            label="私钥文件"
            rules={[{ required: true, message: "请选择私钥文件" }]}
          >
            <Input.Search
              onSearch={() =>
                void choosePrivateKeyPath().then((path) => {
                  if (path) form.setFieldValue("privateKeyPath", path);
                })
              }
              placeholder="选择或输入私钥文件路径"
              searchButton={
                <Tooltip content="选择私钥文件">
                  <IconFolder />
                </Tooltip>
              }
            />
          </Form.Item>
        ) : sshKey ? (
          <Form.Item label="私钥">
            <Input disabled value="FineShell 托管密钥" />
          </Form.Item>
        ) : (
          <Form.Item
            className="ssh-key-managed-content"
            field="privateKeyContent"
            label="私钥内容"
            rules={[{ required: true, message: "请粘贴完整的私钥内容" }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 7, maxRows: 11 }}
              placeholder={
                "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
              }
              spellCheck={false}
            />
          </Form.Item>
        )}
        <Form.Item field="passphrase" label="私钥口令">
          <Input.Password
            placeholder={sshKey ? "留空则保留原口令" : "没有口令可留空"}
          />
        </Form.Item>
        <div className="modal-actions">
          <Space>
            {sshKey && (
              <Popconfirm
                content="确定清除该密钥已保存的口令？"
                onOk={() =>
                  void removePassphrase(sshKey.id)
                    .then(() => Message.success("私钥口令已清除"))
                    .catch((error) => Message.error(String(error)))
                }
              >
                <Button>清除口令</Button>
              </Popconfirm>
            )}
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

function SshKeySettings() {
  const [sshKeys, setSshKeys] = useState<SshKeyRecord[]>([]);
  const [usage, setUsage] = useState(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingSshKey, setEditingSshKey] = useState<SshKeyRecord | null>(null);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setSshKeys(configuration.sshKeys);
    const nextUsage = new Map<string, number>();
    for (const host of configuration.hosts) {
      if (host.sshKeyId) {
        nextUsage.set(host.sshKeyId, (nextUsage.get(host.sshKeyId) ?? 0) + 1);
      }
    }
    for (const deletedHost of configuration.trash) {
      const sshKeyId = deletedHost.host.sshKeyId;
      if (sshKeyId) {
        nextUsage.set(sshKeyId, (nextUsage.get(sshKeyId) ?? 0) + 1);
      }
    }
    setUsage(nextUsage);
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

  const notifyMainWindow = async () => {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(
      () => undefined,
    );
  };

  const saveSshKey = async (values: SshKeyFormValues) => {
    const sshKeyId = editingSshKey?.id ?? createSshKeyId();
    setActing(true);
    let passphraseStored = false;
    let managedKeyImported = false;
    try {
      const existingSource = editingSshKey
        ? getSshKeySource(editingSshKey)
        : values.source;
      let privateKeyPath = values.privateKeyPath?.trim() ?? "";
      if (!editingSshKey && existingSource === "managed") {
        const result = await importManagedSshKey(
          sshKeyId,
          values.privateKeyContent?.trim() ?? "",
        );
        privateKeyPath = result.reference;
        managedKeyImported = true;
      } else if (editingSshKey && existingSource === "managed") {
        privateKeyPath = editingSshKey.privateKeyPath;
      }

      const sshKey: SshKeyRecord = {
        id: sshKeyId,
        name: values.name.trim(),
        privateKeyPath,
        ...(existingSource === "managed" ? { source: "managed" as const } : {}),
      };
      if (values.passphrase) {
        await storePassphrase(sshKeyId, values.passphrase);
        passphraseStored = true;
      }
      const configuration = await upsertSshKey(sshKey);
      setSshKeys(configuration.sshKeys);
      if (values.passphrase) {
        await upsertCredentialReference(
          createCredentialReference(
            "privateKeyPassphrase",
            sshKeyId,
            `密钥：${sshKey.name}`,
          ),
        ).catch(() => {
          Message.warning("密钥已保存，但凭据索引更新失败，可重新扫描");
        });
      }
      await notifyMainWindow().catch(() => undefined);
      setEditorVisible(false);
      setEditingSshKey(null);
      Message.success(editingSshKey ? "密钥已更新" : "密钥已添加");
    } catch (error) {
      if (!editingSshKey && passphraseStored) {
        await removePassphrase(sshKeyId).catch(() => undefined);
      }
      if (managedKeyImported) {
        await deleteManagedSshKey(sshKeyId).catch(() => undefined);
      }
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeSshKey = async (sshKey: SshKeyRecord) => {
    setActing(true);
    try {
      const configuration = await deleteSshKey(sshKey.id);
      setSshKeys(configuration.sshKeys);
      await notifyMainWindow().catch(() => undefined);
      const cleanupFailures: string[] = [];
      await removePassphrase(sshKey.id).catch(() => {
        cleanupFailures.push("系统凭据");
      });
      if (getSshKeySource(sshKey) === "managed") {
        await deleteManagedSshKey(sshKey.id).catch(() => {
          cleanupFailures.push("托管私钥文件");
        });
      }
      if (cleanupFailures.length === 0) {
        Message.success(`已删除 ${sshKey.name}`);
      } else {
        Message.warning(`密钥记录已删除，但${cleanupFailures.join("和")}清理失败`);
      }
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = useMemo<TableColumnProps<SshKeyRecord>[]>(
    () => [
      {
        title: "密钥",
        dataIndex: "name",
        render: (_, sshKey) => (
          <div className="ssh-key-name-cell">
            <Typography.Text bold>{sshKey.name}</Typography.Text>
            <Typography.Text type="secondary">
              {getSshKeySource(sshKey) === "managed"
                ? "FineShell 托管"
                : sshKey.privateKeyPath}
            </Typography.Text>
          </div>
        ),
      },
      {
        title: "使用主机",
        width: 100,
        render: (_, sshKey) => `${usage.get(sshKey.id) ?? 0} 台`,
      },
      {
        title: "操作",
        width: 100,
        render: (_, sshKey) => {
          const used = (usage.get(sshKey.id) ?? 0) > 0;
          return (
            <Space size="mini">
              <Button
                aria-label={`编辑 ${sshKey.name}`}
                disabled={acting}
                icon={<IconEdit />}
                onClick={() => {
                  setEditingSshKey(sshKey);
                  setEditorVisible(true);
                }}
                size="mini"
              />
              <Tooltip content={used ? "仍被主机或回收站记录使用" : undefined}>
                <span>
                  <Popconfirm
                    content={`确定删除密钥“${sshKey.name}”？`}
                    disabled={used}
                    onOk={() => void removeSshKey(sshKey)}
                  >
                    <Button
                      aria-label={`删除 ${sshKey.name}`}
                      disabled={acting || used}
                      icon={<IconDelete />}
                      size="mini"
                      status="danger"
                    />
                  </Popconfirm>
                </span>
              </Tooltip>
            </Space>
          );
        },
      },
    ],
    [acting, usage],
  );

  return (
    <div className="ssh-key-settings">
      <div className="ssh-key-settings-heading">
        <Button
          disabled={loading || acting}
          icon={<IconPlus />}
          onClick={() => {
            setEditingSshKey(null);
            setEditorVisible(true);
          }}
          type="primary"
        >
          新增密钥
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={sshKeys}
        loading={loading}
        noDataElement={<Empty description="暂无密钥" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
      {editorVisible && (
        <SshKeyEditorModal
          onCancel={() => {
            setEditorVisible(false);
            setEditingSshKey(null);
          }}
          onSubmit={(values) => void saveSshKey(values)}
          sshKey={editingSshKey}
          visible
        />
      )}
    </div>
  );
}

export default SshKeySettings;
