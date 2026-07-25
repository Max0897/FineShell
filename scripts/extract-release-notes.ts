import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_TAG_PATTERN =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_HEADING_PATTERN =
  /^##[ \t]+\[([^\]]+)\](?:[ \t]+-[ \t]+[^\r\n]+)?[ \t]*$/gm;

export function releaseVersionFromTag(releaseTag: string) {
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(
      `版本标签“${releaseTag}”格式无效，应使用 v1.2.3 或 v1.2.3-beta.1`,
    );
  }

  return releaseTag.slice(1);
}

export function extractReleaseNotes(changelog: string, releaseTag: string) {
  const version = releaseVersionFromTag(releaseTag);
  const normalizedChangelog = changelog.replaceAll("\r\n", "\n");
  const headings = Array.from(
    normalizedChangelog.matchAll(VERSION_HEADING_PATTERN),
  );
  const headingIndex = headings.findIndex((match) => match[1] === version);

  if (headingIndex < 0) {
    throw new Error(`CHANGELOG.md 缺少版本 ${version} 的更新日志`);
  }

  const heading = headings[headingIndex];
  const sectionStart = (heading.index ?? 0) + heading[0].length;
  const sectionEnd = headings[headingIndex + 1]?.index ?? normalizedChangelog.length;
  const releaseNotes = normalizedChangelog.slice(sectionStart, sectionEnd).trim();

  if (!releaseNotes) {
    throw new Error(`CHANGELOG.md 中版本 ${version} 的更新日志为空`);
  }

  return releaseNotes;
}

function readChangelog() {
  const projectRoot = resolve(import.meta.dir, "..");
  return readFileSync(resolve(projectRoot, "CHANGELOG.md"), "utf8");
}

if (import.meta.main) {
  try {
    const releaseTag = process.argv[2] ?? "";
    const releaseNotes = extractReleaseNotes(readChangelog(), releaseTag);
    process.stdout.write(`${releaseNotes}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
