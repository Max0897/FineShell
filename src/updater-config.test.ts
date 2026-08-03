import { describe, expect, test } from "bun:test";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("updater endpoints", () => {
  test("checks Gitee before falling back to GitHub", () => {
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://gitee.com/Max0897/FineShell/raw/ota/latest.json",
      "https://github.com/Max0897/fineshell/releases/latest/download/latest.json",
    ]);
  });
});
