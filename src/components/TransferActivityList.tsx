import {
  Button,
  Empty,
  Progress,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconDownload,
  IconExclamationCircle,
  IconLaunch,
  IconPause,
  IconPlayArrow,
  IconRefresh,
  IconStop,
  IconSync,
  IconUpload,
} from "@arco-design/web-react/icon";
import type {
  ExternalEditPayload,
  ExternalEditStatus,
  SftpTransferPayload,
} from "../tauri-protocol";
import {
  formatFileSize,
  isActiveSftpTransfer,
  type RemoteArchiveFormat,
  type SftpTransferStatus,
} from "../sftp-utils";

export interface TransferActivityRecord
  extends Omit<SftpTransferPayload, "status"> {
  status: SftpTransferStatus;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  sampledAt: number;
  sampledBytes: number;
  bytesPerSecond: number;
  archiveFormat?: RemoteArchiveFormat;
  archiveSourcePaths?: string[];
}

interface TransferActivityListProps {
  externalEdits: ExternalEditPayload[];
  onCancel: (transfer: TransferActivityRecord) => void;
  onOpenExternalEdit: (edit: ExternalEditPayload) => void;
  onPause: (transfer: TransferActivityRecord) => void;
  onResolveExternalEdit: (edit: ExternalEditPayload) => void;
  onResume: (transfer: TransferActivityRecord) => void;
  onRetry: (transfer: TransferActivityRecord) => void;
  transfers: TransferActivityRecord[];
}

export function externalEditStatusMeta(status: ExternalEditStatus) {
  return {
    watching: { label: "外部编辑中", tone: "active" },
    syncing: { label: "正在同步", tone: "syncing" },
    synced: { label: "已同步", tone: "synced" },
    conflict: { label: "同步冲突", tone: "conflict" },
    failed: { label: "同步失败", tone: "failed" },
    closed: { label: "已结束", tone: "closed" },
  }[status];
}

function formatTransferSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0
    ? `${formatFileSize(bytesPerSecond)}/s`
    : "正在计算";
}

function formatExternalEditTime(updatedAt?: number) {
  if (!updatedAt) return "";
  return new Date(updatedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function TransferActivityList({
  externalEdits,
  onCancel,
  onOpenExternalEdit,
  onPause,
  onResolveExternalEdit,
  onResume,
  onRetry,
  transfers,
}: TransferActivityListProps) {
  if (transfers.length === 0 && externalEdits.length === 0) {
    return (
      <div className="sftp-transfer-empty">
        <Empty description="暂无传输记录" />
      </div>
    );
  }

  return (
    <div className="sftp-transfer-list">
      {transfers.map((transfer) => {
        const percent = transfer.totalBytes
          ? Math.min(
              100,
              Math.round(
                (transfer.transferredBytes / transfer.totalBytes) * 100,
              ),
            )
          : transfer.status === "completed"
            ? 100
            : 0;
        const sizeText = transfer.totalBytes
          ? `${formatFileSize(transfer.transferredBytes)} / ${formatFileSize(transfer.totalBytes)}`
          : transfer.transferredBytes > 0
            ? formatFileSize(transfer.transferredBytes)
            : "等待传输";
        const activityText =
          transfer.status === "completed"
            ? "已完成"
            : transfer.status === "failed"
              ? "传输失败"
              : transfer.status === "cancelled"
                ? "已取消"
                : transfer.status === "paused"
                  ? "已暂停"
                  : transfer.status === "queued"
                    ? "等待中"
                    : formatTransferSpeed(transfer.bytesPerSecond);

        return (
          <div className="sftp-transfer-row" key={transfer.transferId}>
            <span
              className={`sftp-transfer-direction sftp-transfer-direction-${transfer.direction}`}
            >
              {transfer.direction === "upload" ? (
                <IconUpload />
              ) : (
                <IconDownload />
              )}
            </span>
            <div className="sftp-transfer-content">
              <div className="sftp-transfer-title-row">
                <Typography.Text
                  className="sftp-transfer-file-name"
                  ellipsis={{ showTooltip: true }}
                >
                  {transfer.fileName}
                </Typography.Text>
              </div>
              <div className="sftp-transfer-meta">
                <Typography.Text type="secondary">{sizeText}</Typography.Text>
                <Typography.Text
                  className={`sftp-transfer-activity sftp-transfer-activity-${transfer.status}`}
                  type={transfer.status === "failed" ? "error" : "secondary"}
                >
                  {activityText}
                </Typography.Text>
              </div>
              <Progress
                percent={percent}
                showText={false}
                size="small"
                status={transfer.status === "failed" ? "error" : "normal"}
                strokeWidth={3}
              />
              {transfer.status === "failed" && transfer.error && (
                <Typography.Text
                  className="sftp-transfer-error"
                  ellipsis={{ showTooltip: true }}
                  type="error"
                >
                  {transfer.error}
                </Typography.Text>
              )}
            </div>
            <div className="sftp-transfer-actions">
              {transfer.status === "running" && (
                <Tooltip content="暂停">
                  <Button
                    aria-label={`暂停 ${transfer.fileName}`}
                    icon={<IconPause />}
                    onClick={() => onPause(transfer)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
              )}
              {transfer.status === "paused" && (
                <Tooltip content="继续">
                  <Button
                    aria-label={`继续 ${transfer.fileName}`}
                    icon={<IconPlayArrow />}
                    onClick={() => onResume(transfer)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
              )}
              {isActiveSftpTransfer(transfer.status) && (
                <Tooltip content="取消">
                  <Button
                    aria-label={`取消 ${transfer.fileName}`}
                    icon={<IconStop />}
                    onClick={() => onCancel(transfer)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
              )}
              {transfer.status === "failed" && (
                <Tooltip content="重试">
                  <Button
                    aria-label={`重试 ${transfer.fileName}`}
                    icon={<IconRefresh />}
                    onClick={() => onRetry(transfer)}
                    size="mini"
                  />
                </Tooltip>
              )}
            </div>
          </div>
        );
      })}
      {externalEdits.map((edit) => {
        const status = externalEditStatusMeta(edit.status);
        const hasProblem =
          edit.status === "conflict" || edit.status === "failed";
        const updatedAt = formatExternalEditTime(edit.updatedAt);
        return (
          <div
            className="sftp-transfer-row sftp-sync-row"
            key={edit.editId}
          >
            <span
              className={`sftp-transfer-direction sftp-transfer-direction-sync sftp-transfer-direction-sync-${status.tone}`}
            >
              {hasProblem ? <IconExclamationCircle /> : <IconSync />}
            </span>
            <div className="sftp-transfer-content">
              <div className="sftp-transfer-title-row">
                <Typography.Text
                  className="sftp-transfer-file-name"
                  ellipsis={{ showTooltip: true }}
                >
                  {edit.fileName}
                </Typography.Text>
              </div>
              <div className="sftp-transfer-meta">
                <Typography.Text
                  className="sftp-sync-path"
                  ellipsis={{ showTooltip: true }}
                  type="secondary"
                >
                  {edit.remotePath}
                </Typography.Text>
                <Typography.Text
                  className={`sftp-transfer-activity sftp-sync-activity-${status.tone}`}
                  type={edit.status === "failed" ? "error" : "secondary"}
                >
                  {updatedAt ? `${status.label} · ${updatedAt}` : status.label}
                </Typography.Text>
              </div>
              {hasProblem && edit.error && (
                <Typography.Text
                  className="sftp-transfer-error"
                  ellipsis={{ showTooltip: true }}
                  type={edit.status === "failed" ? "error" : "secondary"}
                >
                  {edit.error}
                </Typography.Text>
              )}
            </div>
            <div className="sftp-transfer-actions">
              <Tooltip content="打开本地副本">
                <Button
                  aria-label={`打开 ${edit.fileName} 的本地副本`}
                  icon={<IconLaunch />}
                  onClick={() => onOpenExternalEdit(edit)}
                  size="mini"
                  type="text"
                />
              </Tooltip>
              {hasProblem && (
                <Tooltip content="处理同步问题">
                  <Button
                    aria-label={`处理 ${edit.fileName} 的同步问题`}
                    icon={<IconExclamationCircle />}
                    onClick={() => onResolveExternalEdit(edit)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default TransferActivityList;
