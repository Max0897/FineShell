export type AiProvider = "openai" | "deepseek" | "ollama" | "custom";

export interface AiProviderPreset {
  baseUrl?: string;
  label: string;
  value: AiProvider;
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    value: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
  },
  {
    value: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
  },
  { value: "custom", label: "自定义" },
];

function normalizedBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function canFetchAiModels(baseUrl: string, hasApiKey: boolean) {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.protocol === "http:" && !isLocalAiBaseUrl(baseUrl)) return false;
    return isLocalAiBaseUrl(baseUrl) || hasApiKey;
  } catch {
    return false;
  }
}

export function aiModelFetchSignature(
  baseUrl: string,
  hasApiKey: boolean,
  credentialRevision = 0,
) {
  if (!canFetchAiModels(baseUrl, hasApiKey)) return "";
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return `${normalized}:${hasApiKey ? "key" : "local"}:${credentialRevision}`;
}

export function inferAiProvider(baseUrl: string): AiProvider {
  const normalized = normalizedBaseUrl(baseUrl);
  return (
    AI_PROVIDER_PRESETS.find(
      (preset) =>
        preset.baseUrl && normalizedBaseUrl(preset.baseUrl) === normalized,
    )?.value ?? "custom"
  );
}

export function isLocalAiBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.hostname === "localhost" ||
      url.hostname.startsWith("127.") ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}
