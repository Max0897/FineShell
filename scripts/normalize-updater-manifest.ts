import { readFileSync, writeFileSync } from "node:fs";

interface UpdaterPlatform {
  url?: unknown;
}

interface UpdaterManifest {
  platforms?: unknown;
}

interface GitHubReleaseAsset {
  browser_download_url?: unknown;
  name?: unknown;
  url?: unknown;
}

interface GitHubRelease {
  assets?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubApiAssetUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.hostname === "api.github.com" &&
      /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function releaseAssetUrls(value: unknown) {
  if (!isRecord(value)) throw new Error("GitHub Release 元数据格式无效");

  const release = value as GitHubRelease;
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub Release 元数据缺少 assets 数组");
  }

  const urls = new Map<string, string>();
  release.assets.forEach((value) => {
    if (!isRecord(value)) return;
    const asset = value as GitHubReleaseAsset;
    if (
      typeof asset.url === "string" &&
      typeof asset.browser_download_url === "string"
    ) {
      urls.set(asset.url, asset.browser_download_url);
    }
  });
  return urls;
}

export function normalizeUpdaterManifestUrls(
  value: unknown,
  releaseValue: unknown,
) {
  if (!isRecord(value)) throw new Error("更新清单格式无效");

  const manifest = value as UpdaterManifest;
  if (!isRecord(manifest.platforms)) {
    throw new Error("更新清单缺少 platforms 对象");
  }

  const assetUrls = releaseAssetUrls(releaseValue);
  const normalizedPlatforms: Record<string, unknown> = {};
  const normalizedKeys: string[] = [];

  Object.entries(manifest.platforms).forEach(([key, value]) => {
    if (!isRecord(value)) {
      normalizedPlatforms[key] = value;
      return;
    }

    const platform = value as UpdaterPlatform;
    if (typeof platform.url !== "string" || !isGitHubApiAssetUrl(platform.url)) {
      normalizedPlatforms[key] = value;
      return;
    }

    const publicUrl = assetUrls.get(platform.url);
    if (!publicUrl) {
      throw new Error(`更新清单平台 ${key} 找不到对应的公开下载地址`);
    }

    normalizedPlatforms[key] = { ...value, url: publicUrl };
    normalizedKeys.push(key);
  });

  return {
    manifest: { ...value, platforms: normalizedPlatforms },
    normalizedKeys,
  };
}

if (import.meta.main) {
  try {
    const manifestPath = process.argv[2];
    const releasePath = process.argv[3];
    if (!manifestPath) throw new Error("缺少 latest.json 路径");
    if (!releasePath) throw new Error("缺少 GitHub Release 元数据路径");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const release = JSON.parse(readFileSync(releasePath, "utf8"));
    const normalized = normalizeUpdaterManifestUrls(manifest, release);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(normalized.manifest, null, 2)}\n`,
      "utf8",
    );
    console.log(
      normalized.normalizedKeys.length > 0
        ? `已转换公开下载地址：${normalized.normalizedKeys.join(", ")}`
        : "更新清单已使用公开下载地址",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
