export const FINESHELL_OSC_ID = 633;
export const MAX_SHELL_COMMAND_RESULT_CHARS = 12_000;

export type ShellIntegrationMessage =
  | { kind: "ready"; shell: "bash" | "zsh" }
  | { kind: "end"; exitCode: number }
  | { kind: "unavailable"; reason: string };

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function createShellIntegrationNonce() {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${random}`;
}

export function parseShellIntegrationMessage(
  data: string,
  expectedNonce: string,
): ShellIntegrationMessage | null {
  const [namespace, nonce, kind, value, ...extra] = data.split(";");
  if (
    namespace !== "FineShell" ||
    nonce !== expectedNonce ||
    extra.length > 0
  ) {
    return null;
  }
  if (kind === "ready" && (value === "bash" || value === "zsh")) {
    return { kind, shell: value };
  }
  if (kind === "end" && /^\d{1,3}$/.test(value ?? "")) {
    const exitCode = Number(value);
    return exitCode <= 255 ? { kind, exitCode } : null;
  }
  if (kind === "unavailable" && value) {
    return { kind, reason: value.slice(0, 120) };
  }
  return null;
}

export function buildShellIntegrationInstallCommand(nonce: string) {
  const safeNonce = shellSingleQuote(nonce);
  const bashMarker = `printf '\\033]${FINESHELL_OSC_ID};FineShell;%s;end;%s\\007' "$__fineshell_nonce" "$__fineshell_status"`;
  const readyMarker = (shell: string) =>
    `printf '\\r\\033[2K\\033]${FINESHELL_OSC_ID};FineShell;%s;ready;${shell}\\007' "$__fineshell_nonce"`;
  const unavailableMarker = `printf '\\r\\033[2K\\033]${FINESHELL_OSC_ID};FineShell;%s;unavailable;unsupported-shell\\007' ${safeNonce}`;

  return [
    'if [ -n "${BASH_VERSION-}" ]; then',
    `__fineshell_nonce=${safeNonce};`,
    "__fineshell_pc_was_set=${PROMPT_COMMAND+x};",
    "__fineshell_pc_decl=$(declare -p PROMPT_COMMAND 2>/dev/null || true);",
    `__fineshell_prompt_command(){ __fineshell_status="$1"; ${bashMarker}; return "$__fineshell_status"; };`,
    "if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then PROMPT_COMMAND=('__fineshell_prompt_command \"$?\"' \"${PROMPT_COMMAND[@]}\"); else PROMPT_COMMAND='__fineshell_prompt_command \"$?\"; '" +
      '"${PROMPT_COMMAND-}"; fi;',
    `${readyMarker("bash")};`,
    'elif [ -n "${ZSH_VERSION-}" ]; then',
    `__fineshell_nonce=${safeNonce};`,
    "autoload -Uz add-zsh-hook;",
    `__fineshell_precmd(){ local __fineshell_status=$?; ${bashMarker}; return "$__fineshell_status"; };`,
    "add-zsh-hook -d precmd __fineshell_precmd 2>/dev/null || true;",
    "add-zsh-hook precmd __fineshell_precmd;",
    `${readyMarker("zsh")};`,
    `else ${unavailableMarker}; fi`,
    "\r",
  ].join(" ");
}

export function buildShellIntegrationUninstallCommand() {
  return [
    'if [ -n "${BASH_VERSION-}" ] && command -v __fineshell_prompt_command >/dev/null 2>&1; then',
    'if [ "${__fineshell_pc_was_set-}" = x ]; then eval "$__fineshell_pc_decl"; else unset PROMPT_COMMAND; fi;',
    "unset -f __fineshell_prompt_command; unset __fineshell_nonce __fineshell_pc_decl __fineshell_pc_was_set;",
    'elif [ -n "${ZSH_VERSION-}" ]; then',
    "autoload -Uz add-zsh-hook; add-zsh-hook -d precmd __fineshell_precmd 2>/dev/null || true;",
    "unfunction __fineshell_precmd 2>/dev/null || true; unset __fineshell_nonce; fi;",
    "printf '\\r\\033[2K';",
    "\r",
  ].join(" ");
}

export function boundedShellCommandOutput(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= MAX_SHELL_COMMAND_RESULT_CHARS) {
    return { output: normalized, truncated: false };
  }
  return {
    output: normalized.slice(-MAX_SHELL_COMMAND_RESULT_CHARS),
    truncated: true,
  };
}
