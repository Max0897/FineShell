import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cargoPackageVersion } from "./check-release-version";

export type ReleaseBump = "patch" | "minor" | "major";

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED_HEADING_PATTERN = /^##[ \t]+\[Unreleased\][ \t]*$/m;
const VERSION_HEADING_PATTERN =
  /^##[ \t]+\[[^\]]+\](?:[ \t]+-[ \t]+[^\r\n]+)?[ \t]*$/gm;

export function nextReleaseVersion(current: string, bump: ReleaseBump) {
  const match = current.match(SEMVER_PATTERN);
  if (!match) throw new Error(`当前版本“${current}”不是稳定语义化版本`);

  const [, majorValue, minorValue, patchValue] = match;
  let major = Number(majorValue);
  let minor = Number(minorValue);
  let patch = Number(patchValue);

  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

export function updateJsonVersion(contents: string, version: string) {
  const value = JSON.parse(contents) as Record<string, unknown>;
  value.version = version;
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function updateCargoPackageVersion(contents: string, version: string) {
  const packageMatch = contents.match(/\[package\][\s\S]*?(?=\n\[[^\]]+\]|$)/);
  if (!packageMatch) throw new Error("Cargo.toml 缺少 [package] 配置");

  const updatedPackage = packageMatch[0].replace(
    /^(\s*version\s*=\s*")[^"]+("\s*)$/m,
    `$1${version}$2`,
  );
  if (updatedPackage === packageMatch[0]) {
    throw new Error("Cargo.toml 缺少 package.version");
  }

  return contents.replace(packageMatch[0], updatedPackage);
}

export function updateCargoLockVersion(
  contents: string,
  currentVersion: string,
  version: string,
) {
  const packageBlocks = Array.from(
    contents.matchAll(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g),
  );
  const escapedCurrentVersion = currentVersion.replaceAll(".", "\\.");
  const rootPackage = packageBlocks.find(
    (match) =>
      /^name = "fineshell"$/m.test(match[0]) &&
      new RegExp(`^version = "${escapedCurrentVersion}"$`, "m").test(match[0]),
  );
  if (!rootPackage) {
    throw new Error(`Cargo.lock 缺少 fineshell ${currentVersion} 包记录`);
  }

  const updatedPackage = rootPackage[0].replace(
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  return contents.replace(rootPackage[0], updatedPackage);
}

function hasReleaseNotes(contents: string) {
  return (
    contents
      .replace(/<!--[^]*?-->/g, "")
      .replace(/^#{3,}[ \t]+.*$/gm, "")
      .trim().length > 0
  );
}

export function prepareReleaseChangelog(
  changelog: string,
  version: string,
  releaseDate: string,
) {
  const normalized = changelog.replaceAll("\r\n", "\n");
  const unreleased = normalized.match(UNRELEASED_HEADING_PATTERN);
  if (!unreleased || unreleased.index === undefined) {
    throw new Error("CHANGELOG.md 缺少 ## [Unreleased] 区域");
  }

  VERSION_HEADING_PATTERN.lastIndex = unreleased.index + unreleased[0].length;
  const nextHeading = VERSION_HEADING_PATTERN.exec(normalized);
  const sectionStart = unreleased.index + unreleased[0].length;
  const sectionEnd = nextHeading?.index ?? normalized.length;
  const releaseNotes = normalized.slice(sectionStart, sectionEnd).trim();
  if (!hasReleaseNotes(releaseNotes)) {
    throw new Error("CHANGELOG.md 的 Unreleased 区域没有可发布内容");
  }

  const freshUnreleased =
    "## [Unreleased]\n\n### 新增\n\n### 修复\n\n### 优化\n\n### 工程";
  const releaseHeading = `## [${version}] - ${releaseDate}`;
  const replacement = `${freshUnreleased}\n\n${releaseHeading}\n\n${releaseNotes}\n\n`;
  return `${normalized.slice(0, unreleased.index)}${replacement}${normalized
    .slice(sectionEnd)
    .replace(/^\s+/, "")}`;
}

function requireCleanWorktree(projectRoot: string) {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  if (status) {
    throw new Error("准备发布前工作区必须保持干净，请先提交现有变更");
  }
}

function readJsonVersion(contents: string, path: string) {
  const value = JSON.parse(contents) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error(`${path} 缺少 version`);
  return value.version;
}

function prepareRelease(bump: ReleaseBump) {
  const projectRoot = resolve(import.meta.dir, "..");
  requireCleanWorktree(projectRoot);

  const packagePath = resolve(projectRoot, "package.json");
  const tauriPath = resolve(projectRoot, "src-tauri/tauri.conf.json");
  const cargoPath = resolve(projectRoot, "src-tauri/Cargo.toml");
  const cargoLockPath = resolve(projectRoot, "src-tauri/Cargo.lock");
  const changelogPath = resolve(projectRoot, "CHANGELOG.md");
  const packageContents = readFileSync(packagePath, "utf8");
  const tauriContents = readFileSync(tauriPath, "utf8");
  const cargoContents = readFileSync(cargoPath, "utf8");
  const cargoLockContents = readFileSync(cargoLockPath, "utf8");
  const changelogContents = readFileSync(changelogPath, "utf8");

  const versions = [
    readJsonVersion(packageContents, "package.json"),
    readJsonVersion(tauriContents, "src-tauri/tauri.conf.json"),
    cargoPackageVersion(cargoContents),
  ];
  if (new Set(versions).size !== 1) {
    throw new Error(`发布前版本不一致：${versions.join(" / ")}`);
  }

  const currentVersion = versions[0];
  const version = nextReleaseVersion(currentVersion, bump);
  const releaseDate = new Date().toISOString().slice(0, 10);

  const nextPackageContents = updateJsonVersion(packageContents, version);
  const nextTauriContents = updateJsonVersion(tauriContents, version);
  const nextCargoContents = updateCargoPackageVersion(cargoContents, version);
  const nextCargoLockContents = updateCargoLockVersion(
    cargoLockContents,
    currentVersion,
    version,
  );
  const nextChangelogContents = prepareReleaseChangelog(
    changelogContents,
    version,
    releaseDate,
  );

  writeFileSync(packagePath, nextPackageContents);
  writeFileSync(tauriPath, nextTauriContents);
  writeFileSync(cargoPath, nextCargoContents);
  writeFileSync(cargoLockPath, nextCargoLockContents);
  writeFileSync(changelogPath, nextChangelogContents);

  console.log(`FineShell v${version} 发布文件已准备完成`);
}

if (import.meta.main) {
  try {
    const bump = process.argv[2] as ReleaseBump | undefined;
    if (!bump || !["patch", "minor", "major"].includes(bump)) {
      throw new Error("请指定版本级别：patch、minor 或 major");
    }
    prepareRelease(bump);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
