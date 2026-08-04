import {
  Button,
  Checkbox,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Typography,
} from "@arco-design/web-react";
import type { SftpEntry } from "../../models";
import type { ExternalEditPayload } from "../../tauri-protocol";
import {
  formatFileSize,
  formatPermissions,
  permissionFlagsFromValue,
  permissionValueFromFlags,
  remoteArchiveExtension,
  type PermissionFlag,
  type RemoteArchiveFormat,
} from "../../sftp-utils";

export type CreateEntryKind = "file" | "directory";
export type PasteConflictPolicy = "overwrite" | "skip" | "rename";

export interface RemoteTextFile {
  path: string;
  content: string;
  size: number;
  modifiedAt?: number;
  permissions?: number;
}

export interface TextEditorState {
  entry: SftpEntry;
  document: RemoteTextFile | null;
  content: string;
  loading: boolean;
  saving: boolean;
}

export interface ArchiveDialogState {
  entries: SftpEntry[];
  mode: "compress" | "download";
}

const PERMISSION_MATRIX_ROWS = [
  { label: "所有者", scope: "owner" },
  { label: "用户组", scope: "group" },
  { label: "其他", scope: "other" },
] as const;

const PERMISSION_MATRIX_COLUMNS = [
  { label: "读取", capability: "read" },
  { label: "写入", capability: "write" },
  { label: "执行", capability: "execute" },
] as const;

const ARCHIVE_FORMAT_OPTIONS = [
  { label: "Tar Gzip (.tar.gz)", value: "tarGz" },
  { label: "Zip (.zip)", value: "zip" },
  { label: "Tar (.tar)", value: "tar" },
];

interface TextEditorDialogProps {
  byteLength: number;
  maxBytes: number;
  onCancel: () => void;
  onChange: (content: string) => void;
  onSave: () => void;
  state: TextEditorState | null;
}

export function TextEditorDialog({
  byteLength,
  maxBytes,
  onCancel,
  onChange,
  onSave,
  state,
}: TextEditorDialogProps) {
  return (
    <Modal
      cancelButtonProps={{ disabled: Boolean(state?.saving) }}
      className="sftp-text-editor-modal"
      confirmLoading={Boolean(state?.saving)}
      maskClosable={false}
      okButtonProps={{
        disabled: Boolean(
          state?.loading ||
            !state?.document ||
            state.content === state.document.content ||
            byteLength > maxBytes,
        ),
      }}
      okText="保存"
      onCancel={onCancel}
      onOk={onSave}
      title={state ? `编辑文本 - ${state.entry.name}` : "编辑文本"}
      visible={Boolean(state)}
    >
      <div className="sftp-text-editor-body">
        <div className="sftp-text-editor-meta">
          <Typography.Text ellipsis={{ showTooltip: true }} type="secondary">
            {state?.entry.path ?? ""}
          </Typography.Text>
          <Typography.Text type={byteLength > maxBytes ? "error" : "secondary"}>
            {formatFileSize(byteLength)} / 2 MiB
          </Typography.Text>
        </div>
        <div className="sftp-text-editor-field">
          <Input.TextArea
            aria-label="远程文本内容"
            className="sftp-text-editor-input"
            disabled={Boolean(state?.loading || state?.saving)}
            onChange={onChange}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "s"
              ) {
                event.preventDefault();
                onSave();
              }
            }}
            placeholder={state?.loading ? "正在读取远程文件..." : ""}
            spellCheck={false}
            value={state?.content ?? ""}
          />
          {state?.loading && (
            <div className="sftp-text-editor-loading">
              <Spin />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

interface ExternalEditConflictDialogProps {
  edit: ExternalEditPayload | null;
  loading: boolean;
  onCancel: () => void;
  onResolve: (action: "overwrite" | "reload") => void;
}

export function ExternalEditConflictDialog({
  edit,
  loading,
  onCancel,
  onResolve,
}: ExternalEditConflictDialogProps) {
  return (
    <Modal
      footer={
        <Space>
          <Button disabled={loading} onClick={onCancel}>
            保留本地
          </Button>
          <Button disabled={loading} onClick={() => onResolve("reload")}>
            重新加载远端
          </Button>
          <Button
            loading={loading}
            onClick={() => onResolve("overwrite")}
            status="danger"
            type="primary"
          >
            覆盖远端
          </Button>
        </Space>
      }
      maskClosable={false}
      onCancel={onCancel}
      title={edit?.status === "failed" ? "自动同步失败" : "远程文件已修改"}
      visible={Boolean(edit)}
    >
      <div className="sftp-external-edit-conflict">
        <Typography.Paragraph>
          {edit?.error || "远端文件在本地编辑期间发生了变化。"}
        </Typography.Paragraph>
        <Typography.Text ellipsis={{ showTooltip: true }} type="secondary">
          {edit?.remotePath ?? ""}
        </Typography.Text>
      </div>
    </Modal>
  );
}

interface PasteConflictDialogProps {
  conflictCount: number;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onPolicyChange: (policy: PasteConflictPolicy) => void;
  policy: PasteConflictPolicy;
  visible: boolean;
}

export function PasteConflictDialog({
  conflictCount,
  loading,
  onCancel,
  onConfirm,
  onPolicyChange,
  policy,
  visible,
}: PasteConflictDialogProps) {
  return (
    <Modal
      confirmLoading={loading}
      maskClosable={false}
      onCancel={onCancel}
      onOk={onConfirm}
      title="发现同名项目"
      visible={visible}
    >
      <div className="sftp-paste-conflict">
        <Typography.Paragraph>
          目标目录中有 {conflictCount} 个同名项目，请选择处理方式。
        </Typography.Paragraph>
        <Radio.Group
          direction="vertical"
          onChange={(value) => onPolicyChange(value as PasteConflictPolicy)}
          options={[
            { label: "自动重命名并保留两者", value: "rename" },
            { label: "覆盖同名项目", value: "overwrite" },
            { label: "跳过同名项目", value: "skip" },
          ]}
          value={policy}
        />
      </div>
    </Modal>
  );
}

interface ArchiveDialogProps {
  baseName: string;
  format: RemoteArchiveFormat;
  loading: boolean;
  onBaseNameChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onFormatChange: (value: RemoteArchiveFormat) => void;
  state: ArchiveDialogState | null;
}

export function ArchiveDialog({
  baseName,
  format,
  loading,
  onBaseNameChange,
  onCancel,
  onConfirm,
  onFormatChange,
  state,
}: ArchiveDialogProps) {
  return (
    <Modal
      confirmLoading={loading}
      maskClosable={false}
      onCancel={onCancel}
      onOk={onConfirm}
      okText={state?.mode === "download" ? "选择保存位置" : "压缩"}
      title={
        state?.mode === "download"
          ? `打包下载 ${state.entries.length} 个项目`
          : `压缩 ${state?.entries.length ?? 0} 个项目`
      }
      visible={Boolean(state)}
    >
      <div className="sftp-archive-editor">
        <Input
          addAfter={remoteArchiveExtension(format)}
          addBefore="名称"
          autoFocus
          maxLength={200}
          onChange={onBaseNameChange}
          onPressEnter={onConfirm}
          placeholder="archive"
          value={baseName}
        />
        <Select
          onChange={(value) => onFormatChange(value as RemoteArchiveFormat)}
          options={ARCHIVE_FORMAT_OPTIONS}
          value={format}
        />
      </div>
    </Modal>
  );
}

interface CreateEntryDialogProps {
  kind: CreateEntryKind | null;
  loading: boolean;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
  onNameChange: (value: string) => void;
}

export function CreateEntryDialog({
  kind,
  loading,
  name,
  onCancel,
  onConfirm,
  onNameChange,
}: CreateEntryDialogProps) {
  return (
    <Modal
      confirmLoading={loading}
      maskClosable={false}
      onCancel={onCancel}
      onOk={onConfirm}
      title={kind === "directory" ? "新建文件夹" : "新建文件"}
      visible={Boolean(kind)}
    >
      <Input
        autoFocus
        onChange={onNameChange}
        onPressEnter={onConfirm}
        placeholder={kind === "directory" ? "文件夹名称" : "文件名称"}
        value={name}
      />
    </Modal>
  );
}

interface PermissionsDialogProps {
  entries: SftpEntry[];
  group: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onGroupChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onPermissionChange: (value: string) => void;
  owner: string;
  parsedPermission: number | null;
  permission: string;
}

export function PermissionsDialog({
  entries,
  group,
  loading,
  onCancel,
  onConfirm,
  onGroupChange,
  onOwnerChange,
  onPermissionChange,
  owner,
  parsedPermission,
  permission,
}: PermissionsDialogProps) {
  const selectedFlags =
    parsedPermission === null ? [] : permissionFlagsFromValue(parsedPermission);
  return (
    <Modal
      confirmLoading={loading}
      maskClosable={false}
      onCancel={onCancel}
      onOk={onConfirm}
      title={
        entries.length === 1
          ? `权限与所有者 - ${entries[0].name}`
          : `修改 ${entries.length} 个项目的属性`
      }
      visible={entries.length > 0}
    >
      <div className="sftp-permission-editor">
        <div className="sftp-owner-fields">
          <Input
            addBefore="用户"
            maxLength={128}
            onChange={onOwnerChange}
            placeholder={entries.length > 1 ? "留空保持不变" : "用户名或 UID"}
            value={owner}
          />
          <Input
            addBefore="用户组"
            maxLength={128}
            onChange={onGroupChange}
            placeholder={
              entries.length > 1 ? "留空保持不变" : "用户组名称或 GID"
            }
            value={group}
          />
        </div>
        <Input
          addBefore="权限"
          autoFocus
          maxLength={4}
          onChange={(value) =>
            onPermissionChange(value.replace(/[^0-7]/g, "").slice(0, 4))
          }
          onPressEnter={onConfirm}
          placeholder={entries.length > 1 ? "留空保持不变" : "755"}
          status={permission && parsedPermission === null ? "error" : undefined}
          value={permission}
        />
        <Checkbox.Group
          onChange={(values) => {
            onPermissionChange(
              formatPermissions(
                permissionValueFromFlags(
                  values as PermissionFlag[],
                  parsedPermission ?? 0,
                ),
              ),
            );
          }}
          value={selectedFlags}
        >
          <div className="sftp-permission-matrix">
            <div className="sftp-permission-matrix-header">
              <span />
              {PERMISSION_MATRIX_COLUMNS.map(({ capability, label }) => (
                <span key={capability}>{label}</span>
              ))}
            </div>
            {PERMISSION_MATRIX_ROWS.map(({ label, scope }) => (
              <div className="sftp-permission-matrix-row" key={scope}>
                <span>{label}</span>
                {PERMISSION_MATRIX_COLUMNS.map(
                  ({ capability, label: action }) => {
                    const value = `${scope}-${capability}` as PermissionFlag;
                    return (
                      <span className="sftp-permission-checkbox" key={value}>
                        <Checkbox
                          aria-label={`${label}${action}权限`}
                          value={value}
                        />
                      </span>
                    );
                  },
                )}
              </div>
            ))}
          </div>
        </Checkbox.Group>
      </div>
    </Modal>
  );
}

interface RenameDialogProps {
  entry: SftpEntry | null;
  loading: boolean;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
  onNameChange: (value: string) => void;
}

export function RenameDialog({
  entry,
  loading,
  name,
  onCancel,
  onConfirm,
  onNameChange,
}: RenameDialogProps) {
  return (
    <Modal
      confirmLoading={loading}
      maskClosable={false}
      onCancel={onCancel}
      onOk={onConfirm}
      title="重命名"
      visible={Boolean(entry)}
    >
      <Input
        autoFocus
        onChange={onNameChange}
        onPressEnter={onConfirm}
        placeholder="新名称"
        value={name}
      />
    </Modal>
  );
}
