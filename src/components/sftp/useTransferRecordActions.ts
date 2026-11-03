import { useCallback, useEffect, useState } from "react";
import { Message } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  FineShellCommandError,
  commandErrorMessage,
  invokeProtocolCommand,
} from "../../tauri-protocol";
import type { TransferActivityRecord } from "../TransferActivityList";

async function writeClipboard(value: string) {
  if (isTauri()) return writeClipboardText(value);
  if (!navigator.clipboard) throw new Error("当前环境无法写入剪贴板");
  return navigator.clipboard.writeText(value);
}

export default function useTransferRecordActions() {
  const [homeDirectory, setHomeDirectory] = useState<string>();
  const [missingTransferIds, setMissingTransferIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void homeDir()
      .then((directory) => {
        if (!cancelled) setHomeDirectory(directory);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const runLocalFileCommand = useCallback(
    async (
      command: "local_file_reveal" | "local_file_open",
      transfer: TransferActivityRecord,
    ) => {
      try {
        await invokeProtocolCommand(command, { path: transfer.localPath });
        setMissingTransferIds((current) => {
          if (!current.has(transfer.transferId)) return current;
          const next = new Set(current);
          next.delete(transfer.transferId);
          return next;
        });
      } catch (error) {
        if (
          error instanceof FineShellCommandError &&
          error.code === "not_found"
        ) {
          setMissingTransferIds((current) =>
            new Set(current).add(transfer.transferId),
          );
          Message.warning("文件已被移动或删除");
          return;
        }
        Message.error(commandErrorMessage(error));
      }
    },
    [],
  );

  const revealLocal = useCallback(
    (transfer: TransferActivityRecord) =>
      runLocalFileCommand("local_file_reveal", transfer),
    [runLocalFileCommand],
  );

  const openLocal = useCallback(
    (transfer: TransferActivityRecord) =>
      runLocalFileCommand("local_file_open", transfer),
    [runLocalFileCommand],
  );

  const copyPath = useCallback(async (path: string) => {
    try {
      await writeClipboard(path);
      Message.success("已复制路径");
    } catch {
      Message.error("无法写入剪贴板");
    }
  }, []);

  return {
    copyPath,
    homeDirectory,
    missingTransferIds,
    openLocal,
    revealLocal,
  };
}
