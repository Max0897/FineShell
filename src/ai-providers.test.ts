import { describe, expect, test } from "bun:test";
import {
  aiModelFetchSignature,
  canFetchAiModels,
  inferAiProvider,
  isLocalAiBaseUrl,
} from "./ai-providers";

describe("AI providers", () => {
  test("matches stable presets while tolerating trailing slashes", () => {
    expect(inferAiProvider("https://api.openai.com/v1/")).toBe("openai");
    expect(inferAiProvider("https://api.deepseek.com")).toBe("deepseek");
    expect(inferAiProvider("https://example.com/v1")).toBe("custom");
  });

  test("recognizes only loopback service addresses as local", () => {
    expect(isLocalAiBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalAiBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalAiBaseUrl("http://[::1]:11434/v1")).toBe(true);
    expect(isLocalAiBaseUrl("https://api.example.com/v1")).toBe(false);
  });

  test("loads model lists only after the service can authenticate", () => {
    expect(canFetchAiModels("http://localhost:11434/v1", false)).toBe(true);
    expect(canFetchAiModels("http://api.example.com/v1", true)).toBe(false);
    expect(canFetchAiModels("https://api.example.com/v1", false)).toBe(false);
    expect(canFetchAiModels("https://api.example.com/v1", true)).toBe(true);
    expect(canFetchAiModels("not-a-url", true)).toBe(false);
  });

  test("builds a stable automatic-fetch signature", () => {
    expect(aiModelFetchSignature("https://api.example.com/v1/", true, 2)).toBe(
      "https://api.example.com/v1:key:2",
    );
    expect(aiModelFetchSignature("https://api.example.com/v1", false)).toBe("");
  });
});
