export const AI_SIDEBAR_DEFAULT_WIDTH = 440;
export const AI_SIDEBAR_MIN_WIDTH = 360;
export const AI_SIDEBAR_MAX_WIDTH = 640;
export const MAIN_WINDOW_MIN_WIDTH = 720;

export function clampAiSidebarWidth(width: number) {
  return Math.min(
    AI_SIDEBAR_MAX_WIDTH,
    Math.max(AI_SIDEBAR_MIN_WIDTH, width),
  );
}

export function aiWindowTargetWidth(
  currentWidth: number,
  shouldExpand: boolean,
  appliedExpansion: number,
) {
  return shouldExpand
    ? currentWidth + AI_SIDEBAR_DEFAULT_WIDTH
    : Math.max(MAIN_WINDOW_MIN_WIDTH, currentWidth - appliedExpansion);
}
