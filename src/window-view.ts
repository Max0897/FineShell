export type WindowView = "settings" | "shortcuts";

declare global {
  interface Window {
    __FINESHELL_WINDOW_VIEW__?: unknown;
  }
}

function supportedWindowView(value: string | null): WindowView | null {
  return value === "settings" || value === "shortcuts" ? value : null;
}

export function windowViewFromLocation(
  location: Pick<Location, "hash" | "search"> = window.location,
) {
  const fragment = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  const fragmentView = supportedWindowView(
    new URLSearchParams(fragment).get("view"),
  );

  if (fragmentView) return fragmentView;

  return supportedWindowView(
    new URLSearchParams(location.search).get("view"),
  );
}

export function windowViewFromWindowLabel(label: string | null) {
  if (label === "settings") return "settings";
  if (label === "shortcut-guide") return "shortcuts";
  return null;
}

interface WindowViewContext {
  injectedView?: unknown;
  location?: Pick<Location, "hash" | "search">;
  windowLabel?: string | null;
}

export function windowViewFromContext({
  injectedView,
  location = window.location,
  windowLabel = null,
}: WindowViewContext = {}) {
  const injected =
    typeof injectedView === "string"
      ? supportedWindowView(injectedView)
      : null;
  return (
    injected ??
    windowViewFromWindowLabel(windowLabel) ??
    windowViewFromLocation(location)
  );
}

export function auxiliaryWindowHref(view: WindowView) {
  return `#view=${encodeURIComponent(view)}`;
}
