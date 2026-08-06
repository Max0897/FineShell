export const AI_READ_ONLY_TOOL_OPTIONS = [
  { label: "服务器状态", value: "get_server_status" },
  { label: "进程列表", value: "list_processes" },
  { label: "当前目录", value: "get_current_directory" },
  { label: "网络连接", value: "get_network_connections" },
  { label: "服务状态", value: "inspect_service" },
  { label: "服务日志", value: "read_service_logs" },
  { label: "Ping", value: "ping_target" },
  { label: "路由追踪", value: "trace_route" },
] as const;

export type AiReadOnlyToolName =
  (typeof AI_READ_ONLY_TOOL_OPTIONS)[number]["value"];

export const ALL_AI_READ_ONLY_TOOLS = AI_READ_ONLY_TOOL_OPTIONS.map(
  ({ value }) => value,
);

const AI_READ_ONLY_TOOL_SET = new Set<string>(ALL_AI_READ_ONLY_TOOLS);

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
