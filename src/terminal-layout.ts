interface TerminalGridSpacing {
  containerHeight: number;
  paddingBottom: number;
  paddingTop: number;
  screenHeight: number;
}

export function balancedTerminalGridTopInset({
  containerHeight,
  paddingBottom,
  paddingTop,
  screenHeight,
}: TerminalGridSpacing) {
  const remainingHeight = Math.max(
    0,
    containerHeight - paddingTop - paddingBottom - screenHeight,
  );
  const balancedInset = (paddingBottom + remainingHeight - paddingTop) / 2;
  return Math.max(0, Math.min(remainingHeight, Math.floor(balancedInset)));
}
