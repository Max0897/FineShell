import { useCallback, useMemo, useState } from "react";
import { Message } from "@arco-design/web-react";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpEntry, SftpListResult } from "../../models";
import {
  isRemotePathDescendant,
  nextAvailableRemoteName,
  remoteJoinPath,
} from "../../sftp-utils";
import { commandErrorMessage } from "../../tauri-protocol";
import type { PasteConflictPolicy } from "./SftpDialogs";

export type SftpClipboardMode = "copy" | "cut";

export interface SftpClipboard {
  mode: SftpClipboardMode;
  entries: SftpEntry[];
}

export interface PendingPaste {
  targetDirectory: string;
  clipboard: SftpClipboard;
  conflictCount: number;
}

interface SftpClipboardOptions {
  onClearSelection: () => void;
  onLoadingChange: (loading: boolean) => void;
  onOperationError: (error: unknown) => void;
  onRefreshDirectory: () => void | Promise<void>;
  sessionId?: string;
}

function invalidPasteDirectory(
  clipboard: SftpClipboard,
  targetDirectory: string,
) {
  return clipboard.entries.find(
    (entry) =>
      entry.kind === "directory" &&
      (entry.path === targetDirectory ||
        isRemotePathDescendant(entry.path, targetDirectory)),
  );
}

export default function useSftpClipboard({
  onClearSelection,
  onLoadingChange,
  onOperationError,
  onRefreshDirectory,
  sessionId,
}: SftpClipboardOptions) {
  const [clipboards, setClipboards] = useState<Record<string, SftpClipboard>>(
    {},
  );
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [pasteConflictPolicy, setPasteConflictPolicy] =
    useState<PasteConflictPolicy>("rename");
  const currentClipboard = sessionId ? clipboards[sessionId] : undefined;
  const cutEntryPaths = useMemo(
    () =>
      new Set(
        currentClipboard?.mode === "cut"
          ? currentClipboard.entries.map((entry) => entry.path)
          : [],
      ),
    [currentClipboard],
  );

  const clearClipboard = useCallback((targetSessionId: string) => {
    setClipboards((current) => {
      if (!current[targetSessionId]) return current;
      const next = { ...current };
      delete next[targetSessionId];
      return next;
    });
  }, []);

  function storeClipboard(entries: SftpEntry[], mode: SftpClipboardMode) {
    if (!sessionId || entries.length === 0) return;
    setClipboards((current) => ({
      ...current,
      [sessionId]: {
        mode,
        entries: entries.map((entry) => ({ ...entry })),
      },
    }));
    Message.success(
      `${mode === "copy" ? "已复制" : "已剪切"} ${entries.length} 个项目`,
    );
  }

  async function pasteClipboard(
    clipboard: SftpClipboard,
    targetDirectory: string,
    conflictPolicy: PasteConflictPolicy,
  ) {
    if (!sessionId || clipboard.entries.length === 0) return;
    const invalidDirectory = invalidPasteDirectory(clipboard, targetDirectory);
    if (invalidDirectory) {
      Message.warning(`不能将“${invalidDirectory.name}”放到其自身内部`);
      return;
    }

    onLoadingChange(true);
    let succeeded = 0;
    let skipped = 0;
    const completedSourcePaths = new Set<string>();
    const failures: string[] = [];
    try {
      const targetListing = await invoke<SftpListResult>("sftp_list", {
        sessionId,
        path: targetDirectory,
      });
      const unavailableNames = new Set(
        targetListing.entries.map((entry) => entry.name),
      );

      for (const entry of clipboard.entries) {
        let targetName = entry.name;
        let targetPath = remoteJoinPath(targetListing.path, targetName);
        if (clipboard.mode === "cut" && targetPath === entry.path) {
          skipped += 1;
          continue;
        }

        const conflicts = unavailableNames.has(targetName);
        if (conflicts && conflictPolicy === "skip") {
          skipped += 1;
          continue;
        }
        if (conflicts && conflictPolicy === "rename") {
          targetName = nextAvailableRemoteName(targetName, unavailableNames);
          targetPath = remoteJoinPath(targetListing.path, targetName);
        }

        try {
          await invoke(
            clipboard.mode === "copy" ? "sftp_copy" : "sftp_rename",
            {
              sessionId,
              sourcePath: entry.path,
              targetPath,
              overwrite: conflicts && conflictPolicy === "overwrite",
            },
          );
          unavailableNames.add(targetName);
          completedSourcePaths.add(entry.path);
          succeeded += 1;
        } catch (error) {
          failures.push(`${entry.name}：${commandErrorMessage(error)}`);
        }
      }

      if (clipboard.mode === "cut" && completedSourcePaths.size > 0) {
        setClipboards((current) => {
          const active = current[sessionId];
          if (!active || active.mode !== "cut") return current;
          const remaining = active.entries.filter(
            (entry) => !completedSourcePaths.has(entry.path),
          );
          if (remaining.length > 0) {
            return {
              ...current,
              [sessionId]: { ...active, entries: remaining },
            };
          }
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
      onClearSelection();
      await onRefreshDirectory();
      if (succeeded > 0) {
        Message.success(
          `${clipboard.mode === "copy" ? "已复制" : "已移动"} ${succeeded} 个项目`,
        );
      } else if (skipped > 0 && failures.length === 0) {
        Message.info("没有需要处理的项目");
      }
      if (failures.length > 0) {
        const remaining =
          failures.length > 1 ? `，另有 ${failures.length - 1} 项失败` : "";
        Message.error(`${failures[0]}${remaining}`);
      }
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  async function requestPaste(
    targetDirectory: string,
    clipboard = currentClipboard,
  ) {
    if (!sessionId || !clipboard || clipboard.entries.length === 0) return;
    const invalidDirectory = invalidPasteDirectory(clipboard, targetDirectory);
    if (invalidDirectory) {
      Message.warning(`不能将“${invalidDirectory.name}”放到其自身内部`);
      return;
    }

    onLoadingChange(true);
    try {
      const targetListing = await invoke<SftpListResult>("sftp_list", {
        sessionId,
        path: targetDirectory,
      });
      const targetNames = new Set(
        targetListing.entries.map((entry) => entry.name),
      );
      const conflictCount = clipboard.entries.filter((entry) => {
        const targetPath = remoteJoinPath(targetListing.path, entry.name);
        return (
          !(clipboard.mode === "cut" && targetPath === entry.path) &&
          targetNames.has(entry.name)
        );
      }).length;
      if (conflictCount > 0) {
        setPasteConflictPolicy("rename");
        setPendingPaste({
          targetDirectory: targetListing.path,
          clipboard,
          conflictCount,
        });
      } else {
        await pasteClipboard(clipboard, targetListing.path, "skip");
      }
    } catch (error) {
      onOperationError(error);
    } finally {
      onLoadingChange(false);
    }
  }

  return {
    clearClipboard,
    currentClipboard,
    cutEntryPaths,
    pasteClipboard,
    pasteConflictPolicy,
    pendingPaste,
    requestPaste,
    selectPasteConflictPolicy: setPasteConflictPolicy,
    setPendingPaste,
    storeClipboard,
  };
}
