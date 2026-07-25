export function isApplePlatform(platform = navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function primaryShortcutModifier(platform = navigator.platform) {
  return isApplePlatform(platform) ? "Command" : "Ctrl";
}
