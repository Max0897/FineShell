export const AI_SIDEBAR_DEFAULT_WIDTH = 440;
export const AI_SIDEBAR_MIN_WIDTH = 360;
export const AI_SIDEBAR_MAX_WIDTH = 640;
export const MAIN_WINDOW_MIN_WIDTH = 720;

export function clampAiSidebarWidth(
  width: number,
  workspaceWidth = Number.POSITIVE_INFINITY,
) {
  const availableWidth = Number.isFinite(workspaceWidth)
    ? Math.max(AI_SIDEBAR_MIN_WIDTH, workspaceWidth - MAIN_WINDOW_MIN_WIDTH)
    : AI_SIDEBAR_MAX_WIDTH;
  return Math.min(
    AI_SIDEBAR_MAX_WIDTH,
    availableWidth,
    Math.max(AI_SIDEBAR_MIN_WIDTH, width),
  );
}

export function aiWindowTargetWidth(
  currentWidth: number,
  shouldExpand: boolean,
  expansion: number,
) {
  return shouldExpand
    ? currentWidth + expansion
    : Math.max(MAIN_WINDOW_MIN_WIDTH, currentWidth - expansion);
}
