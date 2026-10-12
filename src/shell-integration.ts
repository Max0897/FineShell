export const FINESHELL_OSC_ID = 633;
export const MAX_SHELL_COMMAND_RESULT_CHARS = 12_000;

export type ShellIntegrationShell = "bash" | "zsh" | "fish";

export type ShellIntegrationMessage =
  | { kind: "ready"; shell: ShellIntegrationShell }
  | { kind: "disabled" }
  | { kind: "cwd"; path: string }
  | { kind: "end"; exitCode: number }
  | { kind: "unavailable"; reason: string };

export interface ShellIntegrationEchoFilter {
  markers: Uint8Array[];
  pending: Uint8Array;
}

const MAX_SHELL_INTEGRATION_HANDSHAKE_BYTES = 32_768;

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
  const [namespace, nonce, kind, ...values] = data.split(";");
  if (namespace !== "FineShell" || nonce !== expectedNonce) {
    return null;
  }
  const value = values[0];
  if (kind === "cwd") {
    const path = values.join(";");
    if (
      path.startsWith("/") &&
      path.length <= 4_096 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
    ) {
      return { kind, path };
    }
    return null;
  }
  if (values.length !== 1) return null;
  if (
    kind === "ready" &&
    (value === "bash" || value === "zsh" || value === "fish")
  ) {
    return { kind, shell: value };
  }
  if (kind === "disabled" && value === "tty") {
    return { kind };
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

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findBytes(value: Uint8Array, pattern: Uint8Array) {
  const lastStart = value.length - pattern.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let index = 0; index < pattern.length; index += 1) {
      if (value[start + index] !== pattern[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function lifecycleMarker(nonce: string, kind: string, value: string) {
  return new TextEncoder().encode(
    `\r\u001b[2K\u001b]${FINESHELL_OSC_ID};FineShell;${nonce};${kind};${value}\u0007`,
  );
}

export function createShellIntegrationEchoFilter(
  nonce: string,
  mutation: "install" | "uninstall",
): ShellIntegrationEchoFilter {
  return {
    markers:
      mutation === "install"
        ? [
            lifecycleMarker(nonce, "ready", "bash"),
            lifecycleMarker(nonce, "ready", "zsh"),
            lifecycleMarker(nonce, "ready", "fish"),
            lifecycleMarker(nonce, "unavailable", "unsupported-shell"),
          ]
        : [lifecycleMarker(nonce, "disabled", "tty")],
    pending: new Uint8Array(),
  };
}

export function filterShellIntegrationEcho(
  filter: ShellIntegrationEchoFilter,
  chunk: Uint8Array,
): { data: Uint8Array; filter?: ShellIntegrationEchoFilter } {
  const value = concatBytes(filter.pending, chunk);
  const matchIndex = filter.markers.reduce((earliest, marker) => {
    const index = findBytes(value, marker);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
  if (matchIndex >= 0) {
    return { data: value.slice(matchIndex) };
  }

  return {
    data: new Uint8Array(),
    filter: {
      ...filter,
      pending: value.slice(-MAX_SHELL_INTEGRATION_HANDSHAKE_BYTES),
    },
  };
}

function bashHistoryCleanup(safeNonce: string) {
  return [
    `__fineshell_history_nonce=${safeNonce};`,
    "for __fineshell_history_step in 1 2; do",
    "__fineshell_history_index=$((HISTCMD-1));",
    "__fineshell_history_line=$(history 1 2>/dev/null || true);",
    'case "$__fineshell_history_line" in *"$__fineshell_history_nonce"*) history -d "$__fineshell_history_index" 2>/dev/null || true;; *) break;; esac;',
    "done;",
    "unset __fineshell_history_nonce __fineshell_history_step __fineshell_history_index __fineshell_history_line;",
  ].join(" ");
}

/**
 * Quotes a value so that bash, zsh, fish and plain POSIX shells all parse it
 * back to the exact same literal text. The result is a run of single-quoted
 * fragments joined by bare `\'` / `\\` escapes; every one of those shells
 * evaluates that sequence identically, which is what lets us ship a single
 * command line that the login shell can parse without knowing it in advance.
 */
function shellCrossQuote(value: string) {
  let quoted = "";
  let literal = "";
  const flush = () => {
    if (literal.length === 0) return;
    quoted += `'${literal}'`;
    literal = "";
  };
  for (const character of value) {
    if (character === "'") {
      flush();
      quoted += "\\'";
    } else if (character === "\\") {
      flush();
      quoted += "\\\\";
    } else {
      literal += character;
    }
  }
  flush();
  return quoted.length > 0 ? quoted : "''";
}

function shellIntegrationEndMarker(statusExpression: string) {
  return `printf '\\033]${FINESHELL_OSC_ID};FineShell;%s;end;%s\\007' "$__fineshell_nonce" ${statusExpression}`;
}

function shellIntegrationCwdMarker() {
  return `case "$PWD" in *[[:cntrl:]]*) ;; /*) printf '\\033]${FINESHELL_OSC_ID};FineShell;%s;cwd;%s\\007' "$__fineshell_nonce" "$PWD";; esac`;
}

/**
 * fish has no `case ... esac` outside `switch`, so the cwd guard is expressed
 * with fish's own `string match` builtin instead of the POSIX `case` form.
 */
function fishIntegrationCwdMarker() {
  return `if string match -q '/*' "$PWD"; and not string match -q -r '[[:cntrl:]]' "$PWD"; printf '\\033]${FINESHELL_OSC_ID};FineShell;%s;cwd;%s\\007' "$__fineshell_nonce" "$PWD"; end`;
}

function shellIntegrationReadyMarker(shell: ShellIntegrationShell) {
  return `printf '\\r\\033[2K\\033]${FINESHELL_OSC_ID};FineShell;%s;ready;${shell}\\007' "$__fineshell_nonce"`;
}

function shellIntegrationUnsupportedMarker(nonce: string) {
  return `printf '\\r\\033[2K\\033]${FINESHELL_OSC_ID};FineShell;%s;unavailable;unsupported-shell\\007' ${shellSingleQuote(nonce)}`;
}

function shellIntegrationDisabledMarker(nonce: string) {
  return `printf '\\r\\033[2K\\033]${FINESHELL_OSC_ID};FineShell;%s;disabled;tty\\007' ${shellSingleQuote(nonce)}`;
}

function bashInstallScript(nonce: string) {
  const safeNonce = shellSingleQuote(nonce);
  return [
    `__fineshell_nonce=${safeNonce};`,
    "__fineshell_pc_was_set=${PROMPT_COMMAND+x};",
    "__fineshell_pc_decl=$(declare -p PROMPT_COMMAND 2>/dev/null || true);",
    `__fineshell_prompt_command(){ __fineshell_status="$1"; ${shellIntegrationEndMarker('"$__fineshell_status"')}; ${shellIntegrationCwdMarker()}; return "$__fineshell_status"; };`,
    "if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then PROMPT_COMMAND=('__fineshell_prompt_command \"$?\"' \"${PROMPT_COMMAND[@]}\"); else PROMPT_COMMAND='__fineshell_prompt_command \"$?\"; '" +
      '"${PROMPT_COMMAND-}"; fi;',
    bashHistoryCleanup(safeNonce),
    `${shellIntegrationReadyMarker("bash")};`,
  ].join(" ");
}

function zshInstallScript(nonce: string) {
  const safeNonce = shellSingleQuote(nonce);
  return [
    `__fineshell_nonce=${safeNonce};`,
    "autoload -Uz add-zsh-hook;",
    `__fineshell_precmd(){ local __fineshell_status=$?; ${shellIntegrationEndMarker('"$__fineshell_status"')}; ${shellIntegrationCwdMarker()}; return "$__fineshell_status"; };`,
    "add-zsh-hook -d precmd __fineshell_precmd 2>/dev/null || true;",
    "add-zsh-hook precmd __fineshell_precmd;",
    `${shellIntegrationReadyMarker("zsh")};`,
  ].join(" ");
}

/**
 * fish's single-quoted strings only treat `\'` and `\\` as escapes, so a
 * dedicated quoting helper keeps the embedded nonce literal in fish.
 */
function fishQuote(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function fishInstallScript(nonce: string) {
  return [
    `set -g __fineshell_nonce ${fishQuote(nonce)};`,
    "if not functions -q __fineshell_original_fish_prompt; functions -c fish_prompt __fineshell_original_fish_prompt 2>/dev/null; end;",
    `function fish_prompt; set -l __fineshell_status $status; ${shellIntegrationEndMarker("$__fineshell_status")}; ${fishIntegrationCwdMarker()}; __fineshell_original_fish_prompt; end;`,
    `${shellIntegrationReadyMarker("fish")};`,
  ].join(" ");
}

function bashUninstallScript(nonce: string) {
  return [
    "if command -v __fineshell_prompt_command >/dev/null 2>&1; then",
    'if [ "${__fineshell_pc_was_set-}" = x ]; then eval "$__fineshell_pc_decl"; else unset PROMPT_COMMAND; fi;',
    "unset -f __fineshell_prompt_command; unset __fineshell_nonce __fineshell_pc_decl __fineshell_pc_was_set;",
    bashHistoryCleanup(shellSingleQuote(nonce)),
    "fi",
  ].join(" ");
}

function zshUninstallScript() {
  return [
    "autoload -Uz add-zsh-hook; add-zsh-hook -d precmd __fineshell_precmd 2>/dev/null || true;",
    "unfunction __fineshell_precmd 2>/dev/null || true; unset __fineshell_nonce;",
  ].join(" ");
}

function fishUninstallScript() {
  return [
    "if functions -q __fineshell_original_fish_prompt;",
    "functions -e fish_prompt; functions -c __fineshell_original_fish_prompt fish_prompt; functions -e __fineshell_original_fish_prompt;",
    "end;",
    "set -e __fineshell_nonce 2>/dev/null;",
  ].join(" ");
}

/**
 * Wraps every shell-specific script in `eval`, which is understood by bash,
 * zsh, fish and POSIX sh alike. Each branch is guarded with syntax that all of
 * them parse the same way, so the login shell only has to launch the branch
 * that matches it instead of parsing a foreign language as a whole.
 */
function shellIntegrationDispatch(branches: readonly string[]) {
  return branches.join(" ");
}

export function buildShellIntegrationInstallCommand(nonce: string) {
  const fallback = `test -z "$BASH_VERSION" && test -z "$ZSH_VERSION" && test -z "$version" && eval ${shellCrossQuote(shellIntegrationUnsupportedMarker(nonce))};`;
  return ` ${shellIntegrationDispatch([
    `test -n "$BASH_VERSION" && eval ${shellCrossQuote(bashInstallScript(nonce))};`,
    `test -z "$BASH_VERSION" && test -n "$ZSH_VERSION" && eval ${shellCrossQuote(zshInstallScript(nonce))};`,
    `test -z "$BASH_VERSION" && test -z "$ZSH_VERSION" && test -n "$version" && eval ${shellCrossQuote(fishInstallScript(nonce))};`,
    fallback,
    "\r",
  ])}`;
}

export function buildShellIntegrationUninstallCommand(nonce: string) {
  return ` ${shellIntegrationDispatch([
    `test -n "$BASH_VERSION" && eval ${shellCrossQuote(bashUninstallScript(nonce))};`,
    `test -z "$BASH_VERSION" && test -n "$ZSH_VERSION" && eval ${shellCrossQuote(zshUninstallScript())};`,
    `test -z "$BASH_VERSION" && test -z "$ZSH_VERSION" && test -n "$version" && eval ${shellCrossQuote(fishUninstallScript())};`,
    `${shellIntegrationDisabledMarker(nonce)};`,
    "\r",
  ])}`;
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
