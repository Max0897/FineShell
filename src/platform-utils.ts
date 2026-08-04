export function isApplePlatform(platform: string = navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function primaryShortcutModifier(platform: string = navigator.platform) {
  return isApplePlatform(platform) ? "Command" : "Ctrl";
}
