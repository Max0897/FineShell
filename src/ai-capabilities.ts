import type {
  AiCapabilityState,
  AiServiceCapabilities,
} from "./tauri-protocol";

export type AiCapabilityKey = keyof AiServiceCapabilities;

export const AI_CAPABILITY_DEFINITIONS: readonly {
  key: AiCapabilityKey;
  label: string;
}[] = [
  { key: "chat", label: "基础对话" },
  { key: "models", label: "模型列表" },
  { key: "streaming", label: "流式输出" },
  { key: "tools", label: "工具调用" },
];

export function aiCapabilityStateLabel(state: AiCapabilityState) {
  if (state === "supported") return "支持";
  if (state === "unsupported") return "不支持";
  return "未确认";
}

export function aiCapabilityStateColor(state: AiCapabilityState) {
  if (state === "supported") return "green";
  if (state === "unsupported") return "red";
  return "gray";
}
