import toolCatalog from "./ai-tool-catalog.json";

export type AiReadOnlyToolName = keyof typeof toolCatalog.diagnostic;

export const AI_READ_ONLY_TOOL_OPTIONS = Object.entries(
  toolCatalog.diagnostic,
).map(([value, definition]) => ({
  label: definition.label,
  value: value as AiReadOnlyToolName,
}));

export const ALL_AI_READ_ONLY_TOOLS = AI_READ_ONLY_TOOL_OPTIONS.map(
  ({ value }) => value,
);

const AI_READ_ONLY_TOOL_SET = new Set<string>(ALL_AI_READ_ONLY_TOOLS);

export function aiReadOnlyToolLabel(name: AiReadOnlyToolName) {
  return toolCatalog.diagnostic[name].label;
}

export function isAiReadOnlyToolName(
  value: string,
): value is AiReadOnlyToolName {
  return AI_READ_ONLY_TOOL_SET.has(value);
}

export function sanitizeAiReadOnlyTools(
  value: unknown,
  legacyEnabled?: unknown,
): AiReadOnlyToolName[] {
  if (!Array.isArray(value)) {
    return legacyEnabled === false ? [] : [...ALL_AI_READ_ONLY_TOOLS];
  }
  return Array.from(
    new Set(
      value.filter(
        (item): item is AiReadOnlyToolName =>
          typeof item === "string" && isAiReadOnlyToolName(item),
      ),
    ),
  );
}

export function aiReadOnlyToolEnabled(
  tools: readonly AiReadOnlyToolName[],
  name: string,
) {
  return isAiReadOnlyToolName(name) && tools.includes(name);
}
