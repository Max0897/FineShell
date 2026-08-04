import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { diagnosticInvoke as invoke, recordDiagnostic } from "../../diagnostics";
import { isActiveSftpTransfer, summarizeSftpTransferBatch } from "../../sftp-utils";
import { commandErrorMessage, listenProtocolEvent } from "../../tauri-protocol";
import type { RemoteArchiveFormat } from "../../sftp-utils";
import type { TransferActivityRecord } from "../TransferActivityList";
import {
  isSftpSessionFailure,
  isSftpTransferCancellation,
} from "./sftpErrors";

const MAX_CONCURRENT_TRANSFERS = 2;

export interface QueueSftpTransferOptions {
  batchId?: string;
  direction: "upload" | "download";
  localPath: string;
  overwrite: boolean;
  remotePath: string;
  sessionId: string;
  totalBytes?: number;
  transferId?: string;
}

export interface QueueSftpArchiveOptions {
  archiveName: string;
  format: RemoteArchiveFormat;
  localPath: string;
  sessionId: string;
  sourcePaths: string[];
  transferId?: string;
}

interface SftpTransfersOptions {
  activeSessionId?: string;
  isSessionReady: (sessionId: string) => boolean;
  onRefreshDirectory: (sessionId: string) => void | Promise<void>;
  onSessionFailure: (sessionId: string, message: string) => void;
}

function createTransferId() {
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function useSftpTransfers({
  activeSessionId,
  isSessionReady,
  onRefreshDirectory,
  onSessionFailure,
}: SftpTransfersOptions) {
  const [transfers, setTransfers] = useState<
    Record<string, TransferActivityRecord>
  >({});
  const transfersRef = useRef(transfers);
  const startingTransfersRef = useRef(new Set<string>());
  const finalizedUploadBatchesRef = useRef(new Set<string>());
  const isSessionReadyRef = useRef(isSessionReady);
  const onRefreshDirectoryRef = useRef(onRefreshDirectory);
  const onSessionFailureRef = useRef(onSessionFailure);

  transfersRef.current = transfers;
  isSessionReadyRef.current = isSessionReady;
  onRefreshDirectoryRef.current = onRefreshDirectory;
  onSessionFailureRef.current = onSessionFailure;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("sftp-transfer", ({ payload }) => {
      if (payload.status === "failed") {
        recordDiagnostic("error", "sftp.transfer", "SFTP 传输失败", {
          error: payload.error,
          sessionId: payload.sessionId,
          transferId: payload.transferId,
        });
      }
      setTransfers((current) => {
        const previous = current[payload.transferId];
        if (!previous) return current;
        if (previous.status === "cancelled" && payload.status !== "cancelled") {
          return current;
        }
        if (previous.status === "paused" && payload.status === "running") {
          return current;
        }
        const now = Date.now();
        const transferredBytes =
          (payload.status === "failed" || payload.status === "cancelled") &&
          payload.transferredBytes === 0
            ? previous.transferredBytes
            : payload.transferredBytes;
        const elapsedSeconds = (now - previous.sampledAt) / 1000;
        const shouldSample =
          transferredBytes >= previous.sampledBytes &&
          (elapsedSeconds >= 0.25 || payload.status !== "running");
        const currentSpeed = shouldSample
          ? (transferredBytes - previous.sampledBytes) /
            Math.max(elapsedSeconds, 0.001)
          : previous.bytesPerSecond;
        const bytesPerSecond =
          payload.status === "paused" || payload.status === "cancelled"
            ? 0
            : shouldSample
              ? previous.bytesPerSecond > 0
                ? previous.bytesPerSecond * 0.6 + currentSpeed * 0.4
                : currentSpeed
              : previous.bytesPerSecond;
        return {
          ...current,
          [payload.transferId]: {
            ...previous,
            ...payload,
            transferredBytes,
            totalBytes: payload.totalBytes || previous.totalBytes,
            sampledAt: shouldSample ? now : previous.sampledAt,
            sampledBytes: shouldSample
              ? transferredBytes
              : previous.sampledBytes,
            bytesPerSecond,
          },
        };
      });
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const executeTransfer = useCallback(
    async (transfer: TransferActivityRecord) => {
      try {
        if (transfer.archiveFormat && transfer.archiveSourcePaths?.length) {
          await invoke("sftp_download_archive", {
            sessionId: transfer.sessionId,
            transferId: transfer.transferId,
            localPath: transfer.localPath,
            sourcePaths: transfer.archiveSourcePaths,
            archiveName: transfer.fileName,
            format: transfer.archiveFormat,
            overwrite: transfer.overwrite,
          });
        } else {
          await invoke(
            transfer.direction === "upload" ? "sftp_upload" : "sftp_download",
            {
              sessionId: transfer.sessionId,
              transferId: transfer.transferId,
              localPath: transfer.localPath,
              remotePath: transfer.remotePath,
              overwrite: transfer.overwrite,
            },
          );
        }
        if (!transfer.batchId) {
          Message.success(
            `${transfer.direction === "upload" ? "上传" : "下载"}完成：${transfer.fileName}`,
          );
          if (transfer.direction === "upload") {
            await onRefreshDirectoryRef.current(transfer.sessionId);
          }
        }
      } catch (error) {
        const message = commandErrorMessage(error);
        const cancelled =
          isSftpTransferCancellation(message) ||
          transfersRef.current[transfer.transferId]?.status === "cancelled";
        setTransfers((current) => {
          const previous = current[transfer.transferId] ?? transfer;
          return {
            ...current,
            [transfer.transferId]: {
              ...previous,
              status: cancelled ? "cancelled" : "failed",
              error: cancelled ? undefined : message,
              bytesPerSecond: 0,
            },
          };
        });
        if (!cancelled) {
          if (isSftpSessionFailure(message)) {
            onSessionFailureRef.current(transfer.sessionId, message);
          }
          if (!transfer.batchId) Message.error(message);
        }
      } finally {
        startingTransfersRef.current.delete(transfer.transferId);
      }
    },
    [],
  );

  useEffect(() => {
    const batches = new Map<string, TransferActivityRecord[]>();
    for (const transfer of Object.values(transfers)) {
      if (transfer.direction !== "upload" || !transfer.batchId) continue;
      const batch = batches.get(transfer.batchId) ?? [];
      batch.push(transfer);
      batches.set(transfer.batchId, batch);
    }

    for (const batchId of finalizedUploadBatchesRef.current) {
      if (!batches.has(batchId)) finalizedUploadBatchesRef.current.delete(batchId);
    }

    for (const [batchId, batch] of batches) {
      if (finalizedUploadBatchesRef.current.has(batchId)) continue;
      const summary = summarizeSftpTransferBatch(
        batch.map((transfer) => transfer.status),
      );
      if (!summary.finished) continue;

      finalizedUploadBatchesRef.current.add(batchId);
      if (summary.failed === 0 && summary.cancelled === 0) {
        Message.success(`上传完成：共 ${summary.completed} 个文件`);
      } else {
        const details = [`成功 ${summary.completed} 个`];
        if (summary.failed > 0) details.push(`失败 ${summary.failed} 个`);
        if (summary.cancelled > 0) details.push(`取消 ${summary.cancelled} 个`);
        const message = `批量上传结束：${details.join("，")}`;
        if (summary.failed === summary.total) Message.error(message);
        else Message.warning(message);
      }
      void onRefreshDirectoryRef.current(batch[0].sessionId);
    }
  }, [transfers]);

  useEffect(() => {
    if (!isTauri()) return;
    const activeCounts = new Map<string, number>();
    for (const transfer of Object.values(transfers)) {
      if (transfer.status === "running" || transfer.status === "paused") {
        activeCounts.set(
          transfer.sessionId,
          (activeCounts.get(transfer.sessionId) ?? 0) + 1,
        );
      }
    }

    for (const transfer of Object.values(transfers)) {
      if (
        transfer.status !== "queued" ||
        startingTransfersRef.current.has(transfer.transferId) ||
        !isSessionReadyRef.current(transfer.sessionId)
      ) {
        continue;
      }
      const activeCount = activeCounts.get(transfer.sessionId) ?? 0;
      if (activeCount >= MAX_CONCURRENT_TRANSFERS) continue;

      startingTransfersRef.current.add(transfer.transferId);
      activeCounts.set(transfer.sessionId, activeCount + 1);
      const runningTransfer = { ...transfer, status: "running" as const };
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: runningTransfer,
      }));
      void executeTransfer(runningTransfer);
    }
  }, [executeTransfer, transfers]);

  const queueTransfer = useCallback((options: QueueSftpTransferOptions) => {
    const transferId = options.transferId ?? createTransferId();
    const fileName =
      options.direction === "upload"
        ? options.localPath.split(/[\\/]/).pop() || options.localPath
        : options.remotePath.split("/").pop() || options.remotePath;
    const record: TransferActivityRecord = {
      sessionId: options.sessionId,
      transferId,
      direction: options.direction,
      fileName,
      transferredBytes: 0,
      totalBytes: options.totalBytes ?? 0,
      status: "queued",
      localPath: options.localPath,
      remotePath: options.remotePath,
      overwrite: options.overwrite,
      sampledAt: Date.now(),
      sampledBytes: 0,
      bytesPerSecond: 0,
      batchId: options.batchId,
    };
    setTransfers((current) => ({ ...current, [transferId]: record }));
  }, []);

  const queueArchiveDownload = useCallback(
    (options: QueueSftpArchiveOptions) => {
      const transferId = options.transferId ?? createTransferId();
      const record: TransferActivityRecord = {
        sessionId: options.sessionId,
        transferId,
        direction: "download",
        fileName: options.archiveName,
        transferredBytes: 0,
        totalBytes: 0,
        status: "queued",
        localPath: options.localPath,
        remotePath: options.sourcePaths[0] ?? "",
        overwrite: true,
        sampledAt: Date.now(),
        sampledBytes: 0,
        bytesPerSecond: 0,
        archiveFormat: options.format,
        archiveSourcePaths: [...options.sourcePaths],
      };
      setTransfers((current) => ({ ...current, [transferId]: record }));
    },
    [],
  );

  const retry = useCallback(
    (transfer: TransferActivityRecord) => {
      if (transfer.archiveFormat && transfer.archiveSourcePaths?.length) {
        queueArchiveDownload({
          archiveName: transfer.fileName,
          format: transfer.archiveFormat,
          localPath: transfer.localPath,
          sessionId: transfer.sessionId,
          sourcePaths: transfer.archiveSourcePaths,
          transferId: transfer.transferId,
        });
        return;
      }
      queueTransfer({
        direction: transfer.direction,
        localPath: transfer.localPath,
        overwrite: transfer.overwrite,
        remotePath: transfer.remotePath,
        sessionId: transfer.sessionId,
        totalBytes: transfer.totalBytes,
        transferId: transfer.transferId,
      });
    },
    [queueArchiveDownload, queueTransfer],
  );

  const pause = useCallback(async (transfer: TransferActivityRecord) => {
    if (transfer.status !== "running") return;
    try {
      await invoke("sftp_pause_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || previous.status !== "running") return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "paused",
            bytesPerSecond: 0,
          },
        };
      });
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }, []);

  const resume = useCallback(async (transfer: TransferActivityRecord) => {
    if (transfer.status !== "paused") return;
    try {
      await invoke("sftp_resume_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || previous.status !== "paused") return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "running",
            sampledAt: Date.now(),
            sampledBytes: previous.transferredBytes,
          },
        };
      });
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }, []);

  const cancel = useCallback(async (transfer: TransferActivityRecord) => {
    if (transfer.status === "queued") {
      startingTransfersRef.current.delete(transfer.transferId);
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: {
          ...transfer,
          status: "cancelled",
          bytesPerSecond: 0,
        },
      }));
      return;
    }
    if (transfer.status !== "running" && transfer.status !== "paused") return;
    try {
      await invoke("sftp_cancel_transfer", {
        sessionId: transfer.sessionId,
        transferId: transfer.transferId,
      });
      setTransfers((current) => {
        const previous = current[transfer.transferId];
        if (!previous || !isActiveSftpTransfer(previous.status)) return current;
        return {
          ...current,
          [transfer.transferId]: {
            ...previous,
            status: "cancelled",
            bytesPerSecond: 0,
          },
        };
      });
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }, []);

  const cancelSessionTransfers = useCallback((sessionId: string) => {
    setTransfers((current) =>
      Object.fromEntries(
        Object.entries(current).map(([transferId, transfer]) => {
          if (
            transfer.sessionId === sessionId &&
            isActiveSftpTransfer(transfer.status)
          ) {
            startingTransfersRef.current.delete(transferId);
            return [
              transferId,
              { ...transfer, status: "cancelled", bytesPerSecond: 0 },
            ];
          }
          return [transferId, transfer];
        }),
      ),
    );
  }, []);

  const clearFinished = useCallback((sessionId: string) => {
    setTransfers((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([, transfer]) =>
            transfer.sessionId !== sessionId ||
            isActiveSftpTransfer(transfer.status),
        ),
      ),
    );
  }, []);

  const currentTransfers = useMemo(
    () =>
      Object.values(transfers)
        .filter((transfer) => transfer.sessionId === activeSessionId)
        .reverse(),
    [activeSessionId, transfers],
  );

  return {
    cancel,
    cancelSessionTransfers,
    clearFinished,
    currentTransfers,
    pause,
    queueArchiveDownload,
    queueTransfer,
    resume,
    retry,
  };
}
