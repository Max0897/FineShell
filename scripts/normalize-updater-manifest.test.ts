import { describe, expect, test } from "bun:test";
import { normalizeUpdaterManifestUrls } from "./normalize-updater-manifest";

const apiUrl =
  "https://api.github.com/repos/example/app/releases/assets/123";
const publicUrl =
  "https://github.com/example/app/releases/download/v1.2.3/app.tar.gz";

describe("updater manifest URL normalization", () => {
  test("maps GitHub API asset URLs to public release downloads", () => {
    const result = normalizeUpdaterManifestUrls(
      {
        version: "1.2.3",
        platforms: {
          "darwin-aarch64": { signature: "signed", url: apiUrl },
          "windows-x86_64": { signature: "signed", url: publicUrl },
        },
      },
      {
        assets: [
          {
            browser_download_url: publicUrl,
            name: "app.tar.gz",
            url: apiUrl,
          },
        ],
      },
    );

    expect(result.normalizedKeys).toEqual(["darwin-aarch64"]);
    expect(result.manifest).toEqual({
      version: "1.2.3",
      platforms: {
        "darwin-aarch64": { signature: "signed", url: publicUrl },
        "windows-x86_64": { signature: "signed", url: publicUrl },
      },
    });
  });

  test("rejects API asset URLs missing from the release", () => {
    expect(() =>
      normalizeUpdaterManifestUrls(
        {
          platforms: {
            "darwin-aarch64": { signature: "signed", url: apiUrl },
          },
        },
        { assets: [] },
      ),
    ).toThrow("找不到对应的公开下载地址");
  });

  test("rejects malformed release metadata", () => {
    expect(() =>
      normalizeUpdaterManifestUrls({ platforms: {} }, {}),
    ).toThrow("缺少 assets 数组");
  });
});
