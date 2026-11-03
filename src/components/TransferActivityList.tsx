import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  Empty,
  Pagination,
  Progress,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCopy,
  IconDelete,
  IconDownload,
  IconExclamationCircle,
  IconFolder,
  IconLaunch,
  IconLocation,
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
import {
  canRevealLocalTransfer,
  revealInFileManagerLabel,
  transferLocation,
} from "../transfer-location";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

const TRANSFERS_PER_PAGE = 20;

export interface TransferActivityRecord extends Omit<
  SftpTransferPayload,
  "status"
> {
  status: SftpTransferStatus;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  sampledAt: number;
  sampledBytes: number;
  bytesPerSecond: number;
  batchId?: string;
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
  homeDirectory?: string;
  missingTransferIds?: ReadonlySet<string>;
  onCopyPath?: (path: string) => void;
  onLocateRemote?: (transfer: TransferActivityRecord) => void;
  onOpenLocal?: (transfer: TransferActivityRecord) => void;
  onRemove?: (transfer: TransferActivityRecord) => void;
  onRevealLocal?: (transfer: TransferActivityRecord) => void;
}

export interface TransferContextMenuHandlers {
  onCopyPath?: (path: string) => void;
  onLocateRemote?: (transfer: TransferActivityRecord) => void;
  onOpenLocal?: (transfer: TransferActivityRecord) => void;
  onRemove?: (transfer: TransferActivityRecord) => void;
  onRetry?: (transfer: TransferActivityRecord) => void;
  onRevealLocal?: (transfer: TransferActivityRecord) => void;
}

export function transferContextMenuItems(
  transfer: TransferActivityRecord,
  handlers: TransferContextMenuHandlers,
  platform: string = navigator.platform,
): ContextMenuItem[] {
  const completed = transfer.status === "completed";
  const items: ContextMenuItem[] = [];
  if (transfer.direction === "download") {
    if (completed && handlers.onOpenLocal) {
      const onOpenLocal = handlers.onOpenLocal;
      items.push({
        key: "open-local",
        label: "打开文件",
        icon: <IconLaunch />,
        onClick: () => onOpenLocal(transfer),
      });
    }
    if (canRevealLocalTransfer(transfer) && handlers.onRevealLocal) {
      const onRevealLocal = handlers.onRevealLocal;
      items.push({
        key: "reveal-local",
        label: revealInFileManagerLabel(platform),
        icon: <IconFolder />,
        onClick: () => onRevealLocal(transfer),
      });
    }
    if (handlers.onCopyPath && transfer.localPath) {
      const onCopyPath = handlers.onCopyPath;
      items.push({
        key: "copy-local-path",
        label: "复制本地路径",
        icon: <IconCopy />,
        onClick: () => onCopyPath(transfer.localPath),
      });
    }
  } else {
    if (completed && handlers.onLocateRemote) {
      const onLocateRemote = handlers.onLocateRemote;
      items.push({
        key: "locate-remote",
        label: "在 SFTP 中定位",
        icon: <IconLocation />,
        onClick: () => onLocateRemote(transfer),
      });
    }
    if (handlers.onCopyPath && transfer.remotePath) {
      const onCopyPath = handlers.onCopyPath;
      items.push({
        key: "copy-remote-path",
        label: "复制远程路径",
        icon: <IconCopy />,
        onClick: () => onCopyPath(transfer.remotePath),
      });
    }
  }
  if (transfer.status === "failed" && handlers.onRetry) {
    const onRetry = handlers.onRetry;
    items.push({
      key: "retry",
      label: "重试",
      icon: <IconRefresh />,
      dividerBefore: items.length > 0,
      onClick: () => onRetry(transfer),
    });
  }
  if (!isActiveSftpTransfer(transfer.status) && handlers.onRemove) {
    const onRemove = handlers.onRemove;
    items.push({
      key: "remove",
      label: "删除记录",
      icon: <IconDelete />,
      danger: true,
      dividerBefore: items.length > 0 && transfer.status !== "failed",
      onClick: () => onRemove(transfer),
    });
  }
  return items;
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
  homeDirectory,
  missingTransferIds,
  onCopyPath,
  onLocateRemote,
  onOpenLocal,
  onRemove,
  onRevealLocal,
}: TransferActivityListProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const transferListRef = useRef<HTMLDivElement>(null);
  const pendingRetryScrollTopRef = useRef<number | null>(null);
  const pageCount = Math.max(
    1,
    Math.ceil(transfers.length / TRANSFERS_PER_PAGE),
  );
  const safeCurrentPage = Math.min(currentPage, pageCount);
  const visibleTransfers = transfers.slice(
    (safeCurrentPage - 1) * TRANSFERS_PER_PAGE,
    safeCurrentPage * TRANSFERS_PER_PAGE,
  );

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, pageCount));
  }, [pageCount]);

  useLayoutEffect(() => {
    const scrollTop = pendingRetryScrollTopRef.current;
    if (scrollTop === null) return;
    const list = transferListRef.current;
    if (list) list.scrollTop = scrollTop;
    pendingRetryScrollTopRef.current = null;
  }, [transfers, safeCurrentPage]);

  const handleRetry = useCallback(
    (transfer: TransferActivityRecord) => {
      const scrollTop = transferListRef.current?.scrollTop ?? 0;
      pendingRetryScrollTopRef.current = scrollTop;
      onRetry(transfer);
      if (transferListRef.current) {
        transferListRef.current.scrollTop = scrollTop;
      }
    },
    [onRetry],
  );

  if (transfers.length === 0 && externalEdits.length === 0) {
    return (
      <div className="sftp-transfer-empty">
        <Empty description="暂无传输记录" />
      </div>
    );
  }

  return (
    <div className="sftp-transfer-list-container">
      <div className="sftp-transfer-list" ref={transferListRef}>
        {visibleTransfers.map((transfer) => {
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
        const missing = missingTransferIds?.has(transfer.transferId) ?? false;
        const location = transferLocation(transfer, homeDirectory);
        const activityText = missing
          ? "已删除"
          : transfer.status === "completed"
            ? "已完成"
            : transfer.status === "failed"
              ? "传输失败"
              : transfer.status === "cancelled"
                ? "已取消"
                : transfer.status === "paused"
                  ? "已暂停"
                  : transfer.status === "waiting"
                    ? "等待远程响应"
                    : transfer.status === "queued"
                      ? "等待中"
                      : formatTransferSpeed(transfer.bytesPerSecond);

        const contextMenuItems = transferContextMenuItems(transfer, {
          onCopyPath,
          onLocateRemote,
          onOpenLocal,
          onRemove,
          onRetry: handleRetry,
          onRevealLocal,
        });

        return (
          <ContextMenu
            disabled={contextMenuItems.length === 0}
            items={contextMenuItems}
            key={transfer.transferId}
          >
          <div
            className={`sftp-transfer-row${missing ? " sftp-transfer-row-missing" : ""}`}
          >
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
              {location.fullPath && (
                <Tooltip content={location.fullPath} position="tl">
                  <Typography.Text
                    className="sftp-transfer-location"
                    type="secondary"
                  >
                    → {location.label}
                  </Typography.Text>
                </Tooltip>
              )}
              <div className="sftp-transfer-meta">
                <Typography.Text type="secondary">{sizeText}</Typography.Text>
                <Typography.Text
                  className={`sftp-transfer-activity sftp-transfer-activity-${missing ? "missing" : transfer.status}`}
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
              {canRevealLocalTransfer(transfer) && !missing && onRevealLocal && (
                <Tooltip content={revealInFileManagerLabel()}>
                  <Button
                    aria-label={`${revealInFileManagerLabel()} ${transfer.fileName}`}
                    icon={<IconFolder />}
                    onClick={() => onRevealLocal(transfer)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
              )}
              {(transfer.status === "running" ||
                transfer.status === "waiting") && (
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
                    onClick={() => handleRetry(transfer)}
                    size="mini"
                  />
                </Tooltip>
              )}
            </div>
          </div>
          </ContextMenu>
        );
        })}
        {externalEdits.map((edit) => {
        const status = externalEditStatusMeta(edit.status);
        const hasProblem =
          edit.status === "conflict" || edit.status === "failed";
        const updatedAt = formatExternalEditTime(edit.updatedAt);
        return (
          <div className="sftp-transfer-row sftp-sync-row" key={edit.editId}>
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
      {pageCount > 1 && (
        <div
          aria-label="传输记录分页"
          className="sftp-transfer-pagination"
        >
          <Pagination
            current={safeCurrentPage}
            hideOnSinglePage
            onChange={setCurrentPage}
            pageSize={TRANSFERS_PER_PAGE}
            showTotal={(total, range) => `${range[0]}-${range[1]} / ${total}`}
            size="small"
            total={transfers.length}
          />
        </div>
      )}
    </div>
  );
}

export default TransferActivityList;
