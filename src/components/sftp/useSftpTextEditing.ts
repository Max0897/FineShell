import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Message, Modal } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { diagnosticInvoke as invoke, recordDiagnostic } from "../../diagnostics";
import type { SftpEntry } from "../../models";
import {
  commandErrorMessage,
  listenProtocolEvent,
  type ExternalEditPayload,
  type ExternalEditResult,
} from "../../tauri-protocol";
import type {
  RemoteTextFile,
  TextEditorState,
} from "./SftpDialogs";

export const REMOTE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const REMOTE_TEXT_CONFLICT_ERROR = "远程文件已被其他程序修改";

interface SftpTextEditingOptions {
  onOperationError: (error: unknown) => void;
  onRefreshDirectory: () => void | Promise<void>;
  sessionId?: string;
}

export default function useSftpTextEditing({
  onOperationError,
  onRefreshDirectory,
  sessionId,
}: SftpTextEditingOptions) {
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [externalEdits, setExternalEdits] = useState<
    Record<string, ExternalEditPayload>
  >({});
  const [externalEditConflict, setExternalEditConflict] =
    useState<ExternalEditPayload | null>(null);
  const [externalEditActionLoading, setExternalEditActionLoading] =
    useState(false);
  const requestRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const onOperationErrorRef = useRef(onOperationError);
  const onRefreshDirectoryRef = useRef(onRefreshDirectory);

  sessionIdRef.current = sessionId;
  onOperationErrorRef.current = onOperationError;
  onRefreshDirectoryRef.current = onRefreshDirectory;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("sftp-external-edit", ({ payload }) => {
      const record = { ...payload, updatedAt: Date.now() };
      setExternalEdits((current) => {
        if (payload.status === "closed") {
          const next = { ...current };
          delete next[payload.editId];
          return next;
        }
        const next = Object.fromEntries(
          Object.entries(current).filter(
            ([editId, edit]) =>
              editId === payload.editId ||
              edit.sessionId !== payload.sessionId ||
              edit.remotePath !== payload.remotePath,
          ),
        );
        return { ...next, [payload.editId]: record };
      });

      if (payload.status === "conflict") {
        if (payload.sessionId === sessionIdRef.current) {
          setExternalEditConflict(record);
        }
      } else if (payload.status === "synced" || payload.status === "closed") {
        setExternalEditConflict((current) =>
          current?.editId === payload.editId ? null : current,
        );
      } else if (
        payload.status === "failed" &&
        payload.sessionId === sessionIdRef.current &&
        payload.error
      ) {
        recordDiagnostic("error", "sftp.externalEdit", "外部编辑同步失败", {
          error: payload.error,
          sessionId: payload.sessionId,
        });
        Message.error(payload.error);
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    setTextEditor(null);
  }, [sessionId]);

  const currentExternalEdits = useMemo(
    () =>
      Object.values(externalEdits)
        .filter((edit) => edit.sessionId === sessionId)
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    [externalEdits, sessionId],
  );

  const textEditorByteLength = useMemo(
    () =>
      textEditor ? new TextEncoder().encode(textEditor.content).byteLength : 0,
    [textEditor],
  );

  const resetTextEditor = useCallback(() => {
    requestRef.current += 1;
    setTextEditor(null);
  }, []);

  const requestCloseTextEditor = useCallback(() => {
    if (!textEditor || textEditor.saving) return;
    if (
      textEditor.document &&
      textEditor.content !== textEditor.document.content
    ) {
      Modal.confirm({
        cancelText: "继续编辑",
        content: "当前修改尚未保存，关闭后将丢失这些内容。",
        okButtonProps: { status: "danger" },
        okText: "放弃修改",
        onOk: resetTextEditor,
        title: "放弃未保存的修改？",
      });
      return;
    }
    resetTextEditor();
  }, [resetTextEditor, textEditor]);

  const openTextEditor = useCallback(
    async (entry: SftpEntry) => {
      if (!sessionId || entry.kind !== "file") return;
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setTextEditor({
        entry,
        document: null,
        content: "",
        loading: true,
        saving: false,
      });
      try {
        const document = await invoke<RemoteTextFile>("sftp_read_text_file", {
          sessionId,
          path: entry.path,
        });
        if (requestRef.current !== requestId) return;
        setTextEditor({
          entry,
          document,
          content: document.content,
          loading: false,
          saving: false,
        });
      } catch (error) {
        if (requestRef.current !== requestId) return;
        setTextEditor(null);
        onOperationErrorRef.current(error);
      }
    },
    [sessionId],
  );

  const saveTextEditor = useCallback(
    async (overwrite = false) => {
      if (
        !sessionId ||
        !textEditor ||
        textEditor.loading ||
        textEditor.saving
      ) {
        return;
      }
      const document = textEditor.document;
      if (!document) return;
      if (textEditorByteLength > REMOTE_TEXT_MAX_BYTES) {
        Message.error("编辑后的文本超过 2 MiB，无法保存");
        return;
      }
      if (textEditor.content === document.content) return;

      const editor = textEditor;
      setTextEditor((current) =>
        current ? { ...current, saving: true } : current,
      );
      try {
        await invoke<RemoteTextFile>("sftp_write_text_file", {
          sessionId,
          path: editor.entry.path,
          content: editor.content,
          originalContent: document.content,
          overwrite,
        });
        resetTextEditor();
        Message.success(`已保存 ${editor.entry.name}`);
        await onRefreshDirectoryRef.current();
      } catch (error) {
        const message = commandErrorMessage(error);
        setTextEditor((current) =>
          current ? { ...current, saving: false } : current,
        );
        if (!overwrite && message.includes(REMOTE_TEXT_CONFLICT_ERROR)) {
          Modal.confirm({
            cancelText: "取消",
            content: "远程内容已发生变化。强制保存会覆盖其他程序写入的内容。",
            okButtonProps: { status: "danger" },
            okText: "覆盖保存",
            onOk: () => saveTextEditor(true),
            title: "远程文件已修改",
          });
        } else {
          onOperationErrorRef.current(error);
        }
      }
    },
    [resetTextEditor, sessionId, textEditor, textEditorByteLength],
  );

  const updateTextContent = useCallback((content: string) => {
    setTextEditor((current) =>
      current ? { ...current, content } : current,
    );
  }, []);

  const externalEditForEntry = useCallback(
    (entry: SftpEntry) =>
      Object.values(externalEdits).find(
        (edit) =>
          edit.sessionId === sessionId &&
          edit.remotePath === entry.path &&
          edit.status !== "closed",
      ),
    [externalEdits, sessionId],
  );

  const openExternalEditor = useCallback(
    async (entry: SftpEntry, editorPath?: string) => {
      if (!sessionId || entry.kind !== "file") return;
      try {
        const edit = await invoke<ExternalEditResult>(
          "sftp_start_external_edit",
          { sessionId, path: entry.path },
        );
        if (editorPath) {
          await invoke("sftp_launch_external_editor", {
            editId: edit.editId,
            editorPath,
          });
        } else {
          await openPath(edit.localPath);
        }
        Message.success(`已打开 ${entry.name}，保存后将自动同步`);
      } catch (error) {
        onOperationErrorRef.current(error);
      }
    },
    [sessionId],
  );

  const chooseExternalEditor = useCallback(
    async (entry: SftpEntry) => {
      try {
        const selected = await open({
          directory: false,
          multiple: false,
          title: "选择外部编辑器",
        });
        if (typeof selected === "string") {
          await openExternalEditor(entry, selected);
        }
      } catch (error) {
        onOperationErrorRef.current(error);
      }
    },
    [openExternalEditor],
  );

  const resolveExternalEdit = useCallback(
    async (action: "overwrite" | "reload") => {
      if (!externalEditConflict || !sessionId) return;
      setExternalEditActionLoading(true);
      try {
        await invoke("sftp_external_edit_action", {
          editId: externalEditConflict.editId,
          action,
        });
        Message.success(
          action === "overwrite"
            ? "本地内容已覆盖远端文件"
            : "已用远端内容更新本地文件",
        );
        setExternalEditConflict(null);
        await onRefreshDirectoryRef.current();
      } catch (error) {
        onOperationErrorRef.current(error);
      } finally {
        setExternalEditActionLoading(false);
      }
    },
    [externalEditConflict, sessionId],
  );

  const reopenExternalEditLocalFile = useCallback(
    async (edit: ExternalEditPayload) => {
      try {
        await openPath(edit.localPath);
      } catch (error) {
        Message.error(`无法打开本地编辑副本：${commandErrorMessage(error)}`);
      }
    },
    [],
  );

  return {
    chooseExternalEditor,
    currentExternalEdits,
    externalEditActionLoading,
    externalEditConflict,
    externalEditForEntry,
    externalEdits,
    openExternalEditor,
    openTextEditor,
    reopenExternalEditLocalFile,
    requestCloseTextEditor,
    resolveExternalEdit,
    selectExternalEditConflict: setExternalEditConflict,
    saveTextEditor,
    textEditor,
    textEditorByteLength,
    updateTextContent,
  };
}
