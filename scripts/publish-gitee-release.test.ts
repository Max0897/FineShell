import { describe, expect, test } from "bun:test";
import { createGiteeUpdaterManifest } from "./publish-gitee-release";

const githubUrl =
  "https://github.com/Max0897/fineshell/releases/download/v1.2.3/FineShell_1.2.3_windows_x64-setup.exe";
const giteeUrl =
  "https://gitee.com/api/v5/repos/Max0897/FineShell/releases/42/attach_files/7/download";

describe("Gitee updater manifest", () => {
  test("maps updater assets by their release file names", () => {
    const result = createGiteeUpdaterManifest(
      {
        version: "1.2.3",
        platforms: {
          "windows-x86_64-nsis": {
            signature: "signed",
            url: githubUrl,
          },
        },
      },
      [
        {
          browser_download_url: giteeUrl,
          id: 7,
          name: "FineShell_1.2.3_windows_x64-setup.exe",
          size: 1024,
        },
      ],
    );

    expect(result.normalizedKeys).toEqual(["windows-x86_64-nsis"]);
    expect(result.manifest).toEqual({
      version: "1.2.3",
      platforms: {
        "windows-x86_64-nsis": {
          signature: "signed",
          url: giteeUrl,
        },
      },
    });
  });

  test("decodes escaped release file names", () => {
    const result = createGiteeUpdaterManifest(
      {
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url: "https://github.com/example/releases/download/v1.2.3/FineShell%20Updater.tar.gz",
          },
        },
      },
      [
        {
          browser_download_url: giteeUrl,
          id: 7,
          name: "FineShell Updater.tar.gz",
          size: 1024,
        },
      ],
    );

    expect(
      (result.manifest.platforms as Record<string, { url: string }>)[
        "darwin-aarch64"
      ].url,
    ).toBe(giteeUrl);
  });

  test("rejects missing and duplicate release attachments", () => {
    expect(() =>
      createGiteeUpdaterManifest(
        {
          platforms: {
            "windows-x86_64": { signature: "signed", url: githubUrl },
          },
        },
        [],
      ),
    ).toThrow("缺少更新附件");

    const attachment = {
      browser_download_url: giteeUrl,
      id: 7,
      name: "FineShell_1.2.3_windows_x64-setup.exe",
      size: 1024,
    };
    expect(() =>
      createGiteeUpdaterManifest({ platforms: {} }, [
        attachment,
        { ...attachment, id: 8 },
      ]),
    ).toThrow("存在重名附件");
  });

  test("rejects non-Gitee or insecure attachment URLs", () => {
    expect(() =>
      createGiteeUpdaterManifest({ platforms: {} }, [
        {
          browser_download_url: "https://example.com/file",
          id: 7,
          name: "file",
          size: 1,
        },
      ]),
    ).toThrow("必须使用 gitee.com HTTPS 地址");
  });
});
