import spec from "../protocol/command-risk.json";

// Mirrors src-tauri/src/agent_command_risk.rs. Both sides read the same rules
// so the frontend never auto-approves a command the backend would hold back.

export type CommandRiskClass = "read_only" | "mutating" | "destructive";

interface ReadOnlyCommandRule {
  subcommands?: string[];
  forbiddenArguments?: string[];
  requiredArguments?: string[];
  maxArguments?: number;
}

const DESTRUCTIVE_PATTERNS = spec.destructivePatterns.map(
  (pattern) => new RegExp(pattern, "i"),
);
const UNSAFE_CHARACTERS = new Set(Array.from(spec.unsafeCharacters));
const READ_ONLY_COMMANDS = new Map<string, ReadOnlyCommandRule>(
  Object.entries(spec.readOnlyCommands),
);

function argumentMatches(argument: string, flag: string) {
  return argument === flag || argument.startsWith(`${flag}=`);
}

function segmentIsReadOnly(segment: string) {
  const [program, ...args] = segment.trim().split(/\s+/).filter(Boolean);
  if (!program) return false;
  const rule = READ_ONLY_COMMANDS.get(program);
  if (!rule) return false;
  if (rule.maxArguments !== undefined && args.length > rule.maxArguments) {
    return false;
  }
  if (
    args.some((argument) =>
      (rule.forbiddenArguments ?? []).some((flag) =>
        argumentMatches(argument, flag),
      ),
    )
  ) {
    return false;
  }
  if (
    rule.requiredArguments?.length &&
    !args.some((argument) => rule.requiredArguments?.includes(argument))
  ) {
    return false;
  }
  if (rule.subcommands?.length) {
    const subcommand = args.find((argument) => !argument.startsWith("-"));
    if (!subcommand || !rule.subcommands.includes(subcommand)) return false;
  }
  return true;
}

export function classifyTerminalCommand(command: string): CommandRiskClass {
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
    return "destructive";
  }
  if (
    !command.trim() ||
    Array.from(command).some((character) => UNSAFE_CHARACTERS.has(character))
  ) {
    return "mutating";
  }
  return command.split("|").every(segmentIsReadOnly) ? "read_only" : "mutating";
}
