import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { recordDiagnostic } from "../../diagnostics";
import { isApplePlatform } from "../../platform-utils";
import { resolveNativeDropPoint } from "../../sftp-utils";
import { commandErrorMessage } from "../../tauri-protocol";

interface NativeSftpDropOptions {
  onUploadPaths: (paths: string[], targetDirectory?: string) => Promise<void>;
  ready: boolean;
}

export default function useNativeSftpDrop({
  onUploadPaths,
  ready,
}: NativeSftpDropOptions) {
  const [active, setActive] = useState(false);
  const [targetPath, setTargetPath] = useState<string>();
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const onUploadPathsRef = useRef(onUploadPaths);
  const readyRef = useRef(ready);

  onUploadPathsRef.current = onUploadPaths;
  readyRef.current = ready;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let scaleFactor = 1;
    const currentWindow = getCurrentWindow();

    const handleDragDrop: Parameters<
      typeof currentWindow.onDragDropEvent
    >[0] = ({ payload }) => {
      if (payload.type === "leave") {
        setActive(false);
        setTargetPath(undefined);
        return;
      }
      const rect = dropZoneRef.current?.getBoundingClientRect();
      const point = rect
        ? resolveNativeDropPoint(
            payload.position,
            scaleFactor,
            rect,
            isApplePlatform(),
          )
        : undefined;
      const x = point?.x ?? 0;
      const y = point?.y ?? 0;
      const inside = Boolean(readyRef.current && point?.inside);
      const row = inside
        ? document
            .elementFromPoint(x, y)
            ?.closest<HTMLElement>("[data-sftp-entry-id]")
        : undefined;
      const targetDirectory =
        row?.dataset.sftpEntryKind === "directory"
          ? row.dataset.sftpEntryPath
          : undefined;

      if (payload.type === "drop") {
        setActive(false);
        setTargetPath(undefined);
        recordDiagnostic("info", "sftp.drag-drop", "收到本地文件拖放事件", {
          accepted: inside,
          coordinateMode: point?.coordinateMode ?? "unknown",
          itemCount: payload.paths.length,
          ready: readyRef.current,
        });
        if (inside) {
          void onUploadPathsRef.current(payload.paths, targetDirectory);
        }
        return;
      }
      setActive(inside);
      setTargetPath(targetDirectory);
    };

    void (async () => {
      try {
        scaleFactor = await currentWindow.scaleFactor();
        const stopListening = await currentWindow.onDragDropEvent(handleDragDrop);
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      } catch (error) {
        recordDiagnostic("error", "sftp.drag-drop", "注册文件拖放监听失败", {
          error: commandErrorMessage(error),
        });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return {
    active,
    dropZoneRef,
    targetPath,
  };
}
