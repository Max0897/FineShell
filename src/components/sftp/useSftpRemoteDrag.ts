import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import type { SftpEntry } from "../../models";
import { isRemotePathDescendant } from "../../sftp-utils";

interface RemoteDragPreview {
  count: number;
  kind: SftpEntry["kind"];
  label: string;
  x: number;
  y: number;
}

interface RemoteDragState {
  active: boolean;
  entries: SftpEntry[];
  pointerId: number;
  startX: number;
  startY: number;
}

interface SftpRemoteDragOptions {
  disabled: boolean;
  entries: SftpEntry[];
  onMove: (entries: SftpEntry[], targetDirectory: string) => void;
  resetKey: string;
  selectedEntryKeys: string[];
  setSelectedEntryKeys: Dispatch<SetStateAction<string[]>>;
}

export default function useSftpRemoteDrag({
  disabled,
  entries,
  onMove,
  resetKey,
  selectedEntryKeys,
  setSelectedEntryKeys,
}: SftpRemoteDragOptions) {
  const [dropTargetPath, setDropTargetPath] = useState<string>();
  const [preview, setPreview] = useState<RemoteDragPreview>();
  const dragRef = useRef<RemoteDragState>();
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const selectedDragEntries = useCallback(
    (entry: SftpEntry) =>
      selectedEntryKeys.includes(entry.id)
        ? entries.filter((candidate) =>
            selectedEntryKeys.includes(candidate.id),
          )
        : [entry],
    [entries, selectedEntryKeys],
  );

  const canDrop = useCallback(
    (dragEntries: SftpEntry[], targetDirectory: string) =>
      !dragEntries.some(
        (entry) =>
          entry.kind === "directory" &&
          (entry.path === targetDirectory ||
            isRemotePathDescendant(entry.path, targetDirectory)),
      ),
    [],
  );

  const directoryAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY);
      const row = target?.closest<HTMLElement>("[data-sftp-entry-id]");
      const entry = entries.find(
        (candidate) => candidate.id === row?.dataset.sftpEntryId,
      );
      return entry?.kind === "directory" ? entry : undefined;
    },
    [entries],
  );

  const clear = useCallback(() => {
    dragRef.current = undefined;
    setDropTargetPath(undefined);
    setPreview(undefined);
    document.body.classList.remove("sftp-remote-dragging");
  }, []);

  const start = useCallback(
    (event: PointerEvent<HTMLElement>, entry: SftpEntry) => {
      if (event.button !== 0 || disabled) return;
      const dragEntries = selectedDragEntries(entry);
      dragRef.current = {
        active: false,
        entries: dragEntries.map((item) => ({ ...item })),
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [disabled, selectedDragEntries],
  );

  const move = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      if (!drag.active) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 5) return;
        drag.active = true;
        const firstEntry = drag.entries[0];
        setPreview({
          count: drag.entries.length,
          kind: firstEntry?.kind ?? "file",
          label: firstEntry?.name ?? "远程项目",
          x: event.clientX,
          y: event.clientY,
        });
        if (firstEntry && !selectedEntryKeys.includes(firstEntry.id)) {
          setSelectedEntryKeys([firstEntry.id]);
        }
        document.body.classList.add("sftp-remote-dragging");
      }

      event.preventDefault();
      const target = directoryAtPoint(event.clientX, event.clientY);
      const targetPath =
        target && canDrop(drag.entries, target.path)
          ? target.path
          : undefined;
      setDropTargetPath((current) =>
        current === targetPath ? current : targetPath,
      );
      setPreview({
        count: drag.entries.length,
        kind: drag.entries[0]?.kind ?? "file",
        label: drag.entries[0]?.name ?? "远程项目",
        x: event.clientX,
        y: event.clientY,
      });
    },
    [canDrop, directoryAtPoint, selectedEntryKeys, setSelectedEntryKeys],
  );

  const finish = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const target = drag.active
        ? directoryAtPoint(event.clientX, event.clientY)
        : undefined;
      const shouldMove = target && canDrop(drag.entries, target.path);
      if (drag.active) {
        event.preventDefault();
        event.stopPropagation();
      }
      clear();
      if (shouldMove && target) {
        onMoveRef.current(drag.entries, target.path);
      }
    },
    [canDrop, clear, directoryAtPoint],
  );

  const cancel = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      clear();
    },
    [clear],
  );

  useEffect(() => {
    clear();
  }, [clear, resetKey]);

  useEffect(
    () => () => {
      document.body.classList.remove("sftp-remote-dragging");
    },
    [],
  );

  return {
    cancel,
    dropTargetPath,
    finish,
    move,
    preview,
    start,
  };
}
