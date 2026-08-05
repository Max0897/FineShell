import { describe, expect, test } from "bun:test";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceMode,
  readAppearanceModeHint,
  resolveAppearance,
  setAppearanceMode,
} from "./appearance";

describe("application appearance", () => {
  test("resolves explicit and system appearance modes", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
  });

  test("applies the Arco dark theme attribute", () => {
    applyAppearanceMode("dark");
    expect(document.body.getAttribute("arco-theme")).toBe("dark");
    expect(document.body.dataset.appearance).toBe("dark");

    applyAppearanceMode("light");
    expect(document.body.hasAttribute("arco-theme")).toBe(false);
    expect(document.body.dataset.appearance).toBe("light");
  });

  test("persists only a valid startup hint", () => {
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    setAppearanceMode("system", { persist: true });
    expect(readAppearanceModeHint()).toBe("system");

    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "unsupported");
    expect(readAppearanceModeHint()).toBe("light");
  });
});
