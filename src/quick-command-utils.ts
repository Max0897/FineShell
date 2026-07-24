import type { QuickCommandRecord } from "./models";

export interface QuickCommandParameter {
  name: string;
  defaultValue?: string;
}

const QUICK_COMMAND_PARAMETER_PATTERN =
  /\{\{\s*([^{}:]+?)\s*(?::\s*([^{}]*?))?\s*\}\}/g;

export function quickCommandParameters(template: string) {
  const parameters = new Map<string, QuickCommandParameter>();
  for (const match of template.matchAll(QUICK_COMMAND_PARAMETER_PATTERN)) {
    const name = match[1].trim();
    if (!name || parameters.has(name)) continue;
    const defaultValue = match[2]?.trim();
    parameters.set(name, {
      name,
      defaultValue: defaultValue || undefined,
    });
  }
  return [...parameters.values()];
}

export function renderQuickCommand(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(
    QUICK_COMMAND_PARAMETER_PATTERN,
    (_, rawName: string, rawDefaultValue?: string) => {
      const name = rawName.trim();
      const value = values[name];
      return value === undefined || !value.trim()
        ? rawDefaultValue?.trim() ?? ""
        : value;
    },
  );
}

export function filterQuickCommands(
  commands: QuickCommandRecord[],
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return commands;
  return commands.filter((command) =>
    [command.name, command.group, command.description, command.command].some(
      (value) => value?.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}
