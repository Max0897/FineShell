export function decodeSshOutput(value: string) {
  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(value.padEnd(value.length + padding, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
