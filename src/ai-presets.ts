import type { AiContextSource, AiContextSourceId } from "./ai-utils";

export type AiPromptPresetId =
  | "explain-output"
  | "analyze-server"
  | "diagnose-network"
  | "generate-command";

export interface AiPromptPreset {
  contextIds: AiContextSourceId[];
  id: AiPromptPresetId;
  label: string;
  prompt: string;
}

export const AI_PROMPT_PRESETS: readonly AiPromptPreset[] = [
  {
    id: "explain-output",
    label: "解释终端输出",
    prompt: "请解释当前终端输出，指出异常信息，并给出可验证的排查步骤。",
    contextIds: ["terminal-selection", "terminal-output"],
  },
  {
    id: "analyze-server",
    label: "分析服务器状态",
    prompt: "请分析当前服务器资源状态，指出潜在瓶颈，并给出验证建议。",
    contextIds: ["server-monitor"],
  },
  {
    id: "diagnose-network",
    label: "排查网络问题",
    prompt: "请结合当前服务器状态和终端输出，给出网络问题的排查顺序与验证命令。",
    contextIds: ["server-monitor", "terminal-output"],
  },
  {
    id: "generate-command",
    label: "生成 Shell 命令",
    prompt: "请根据以下目标生成安全、可验证的 Shell 命令，并说明每条命令的作用：",
    contextIds: [],
  },
];

export function availablePresetContextIds(
  preset: AiPromptPreset,
  sources: AiContextSource[],
) {
  const available = new Set(
    sources
      .filter((source) => source.content.trim())
      .map((source) => source.id),
  );
  return preset.contextIds.filter((id) => available.has(id));
}
