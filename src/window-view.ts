export type WindowView = "settings" | "shortcuts";

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
  location?: Pick<Location, "hash" | "search">;
  windowLabel?: string | null;
}

export function windowViewFromContext({
  location = window.location,
  windowLabel = null,
}: WindowViewContext = {}) {
  return (
    windowViewFromWindowLabel(windowLabel) ??
    windowViewFromLocation(location)
  );
}

export function auxiliaryWindowHref(view: WindowView) {
  return `#view=${encodeURIComponent(view)}`;
}
