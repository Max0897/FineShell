import type { AppearanceMode } from "./app-settings";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";

export type ResolvedAppearance = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "fineshell.appearance-mode";

export const APPEARANCE_RESOLVED_EVENT = "fineshell:appearance-resolved";

let currentMode: AppearanceMode = "light";
let initialized = false;

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveAppearance(
  mode: AppearanceMode,
  prefersDark = systemPrefersDark(),
): ResolvedAppearance {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

export function readAppearanceModeHint(): AppearanceMode {
  try {
    const value = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearanceMode(value) ? value : "light";
  } catch {
    return "light";
  }
}

function applyResolvedAppearance(resolved: ResolvedAppearance) {
  document.body.dataset.appearance = resolved;
  document.documentElement.dataset.appearance = resolved;
  document.documentElement.style.colorScheme = resolved;
  if (resolved === "dark") {
    document.body.setAttribute("arco-theme", "dark");
  } else {
    document.body.removeAttribute("arco-theme");
  }
  if (isTauri()) {
    void setNativeTheme(resolved).catch(() => {
      // The web theme remains usable if the native window rejects a theme update.
    });
  }
  window.dispatchEvent(
    new CustomEvent<ResolvedAppearance>(APPEARANCE_RESOLVED_EVENT, {
      detail: resolved,
    }),
  );
}

export function applyAppearanceMode(mode: AppearanceMode) {
  currentMode = mode;
  const resolved = resolveAppearance(mode);
  applyResolvedAppearance(resolved);
  return resolved;
}

export function persistAppearanceMode(mode: AppearanceMode) {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, mode);
  } catch {
    // Theme persistence is only a startup hint; the configuration database remains authoritative.
  }
}

export function setAppearanceMode(
  mode: AppearanceMode,
  options: { persist?: boolean } = {},
) {
  const resolved = applyAppearanceMode(mode);
  if (options.persist) persistAppearanceMode(mode);
  return resolved;
}

export function initializeAppearance() {
  if (initialized) return;
  initialized = true;
  currentMode = readAppearanceModeHint();
  applyAppearanceMode(currentMode);

  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", () => {
    if (currentMode === "system") applyAppearanceMode(currentMode);
  });
  window.addEventListener("storage", (event) => {
    if (
      event.key !== APPEARANCE_STORAGE_KEY ||
      !isAppearanceMode(event.newValue)
    ) {
      return;
    }
    applyAppearanceMode(event.newValue);
  });
}
