import { Input, Message, Modal } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import {
  aiConversationExportFilename,
  serializeAiConversationMarkdown,
} from "../../ai-conversations";
import {
  isAiRemoteFileContextSourceId,
  type AiContextSource,
} from "../../ai-utils";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { AiCommandNotice } from "../../hooks/useAiCommandActions";
import type { AiConversation } from "../../hooks/useAiConversations";
import type {
  AiConversationDeleteConfirmation,
  AiConversationNotice,
  AiConversationRenameRequest,
} from "../../hooks/useAiConversationActions";
import type {
  AiFileChangeConfirmation,
  AiFileChangeNotice,
} from "../../hooks/useAiFileChangeWorkflow";

export function contextSourceDisplayLabel(source: AiContextSource) {
  return isAiRemoteFileContextSourceId(source.id)
    ? `文件:${
        source.label.replace(/^文件:/, "").split("/").pop() || "远程文件"
      }`
    : source.label;
}

export function confirmAiFileChange(confirmation: AiFileChangeConfirmation) {
  Modal.confirm({
    content: confirmation.content,
    okText: confirmation.okText,
    onOk: confirmation.onConfirm,
    title: confirmation.title,
  });
}

export function showAiFileChangeNotice(
  type: AiFileChangeNotice,
  content: string,
) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else Message.error(content);
}

export function showAiCommandNotice(type: AiCommandNotice, content: string) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else if (type === "info") Message.info(content);
  else Message.error(content);
}

export function showAiDraftNotice(content: string) {
  Message.success(content);
}

export function confirmAiConversationDelete(
  confirmation: AiConversationDeleteConfirmation,
) {
  Modal.confirm({
    content: confirmation.content,
    okButtonProps: { status: "danger" },
    okText: "删除",
    onOk: confirmation.onConfirm,
    title: confirmation.title,
  });
}

export function requestAiConversationRename(request: AiConversationRenameRequest) {
  let nextTitle = request.initialValue;
  Modal.confirm({
    content: (
      <Input
        autoFocus
        defaultValue={request.initialValue}
        maxLength={80}
        onChange={(value) => {
          nextTitle = value;
        }}
      />
    ),
    okText: "保存",
    onOk: () => request.onConfirm(nextTitle),
    title: request.title,
  });
}

export function showAiConversationNotice(
  type: AiConversationNotice,
  content: string,
) {
  if (type === "success") Message.success(content);
  else if (type === "warning") Message.warning(content);
  else Message.error(content);
}

export async function copyCode(value: string) {
  if (isTauri()) return writeClipboardText(value);
  if (!navigator.clipboard) throw new Error("当前环境无法写入剪贴板");
  return navigator.clipboard.writeText(value);
}

function downloadMarkdownInBrowser(filename: string, contents: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportAiConversationFile(conversation: AiConversation) {
  const contents = serializeAiConversationMarkdown(conversation);
  const filename = aiConversationExportFilename(conversation);
  if (isTauri()) {
    const path = await save({
      defaultPath: filename,
      filters: [{ extensions: ["md"], name: "Markdown" }],
      title: "导出 AI 对话",
    });
    if (!path) return false;
    await invoke("write_config_file", { path, contents });
    return true;
  }
  downloadMarkdownInBrowser(filename, contents);
  return true;
}
