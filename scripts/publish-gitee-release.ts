import { basename, resolve } from "node:path";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

interface GiteeAttachment {
  browser_download_url: string;
  id: number;
  name: string;
  size: number;
}

interface GiteeRelease {
  id: number;
}

interface UpdaterPlatform {
  url?: unknown;
}

interface UpdaterManifest {
  platforms?: unknown;
}

interface GiteeUpdaterManifestResult {
  manifest: Record<string, unknown>;
  normalizedKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}返回了无效 JSON`);
  }
}

export function parseCurlJsonResponse(
  value: string,
  expectedStatus: number,
  label: string,
) {
  const separator = value.lastIndexOf("\n");
  const statusText = separator >= 0 ? value.slice(separator + 1).trim() : "";
  const body = separator >= 0 ? value.slice(0, separator) : value;
  const status = Number(statusText);
  if (!Number.isInteger(status)) {
    throw new Error(`${label}未返回有效 HTTP 状态`);
  }
  if (status !== expectedStatus) {
    throw new Error(`${label}失败（HTTP ${status}）：${body.slice(0, 500)}`);
  }
  return parseJson(body, label);
}

function parseRelease(value: unknown): GiteeRelease {
  if (!isRecord(value) || !Number.isInteger(value.id)) {
    throw new Error("Gitee Release 响应缺少有效 ID");
  }
  return { id: Number(value.id) };
}

export function parseGiteeReleaseLookup(value: unknown): GiteeRelease | null {
  // Gitee returns HTTP 200 with a JSON null body when the tag exists but a
  // corresponding Release has not been created yet.
  if (value === null) return null;
  return parseRelease(value);
}

function parseAttachment(value: unknown): GiteeAttachment {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.id) ||
    typeof value.name !== "string" ||
    !value.name ||
    !Number.isInteger(value.size) ||
    typeof value.browser_download_url !== "string"
  ) {
    throw new Error("Gitee Release 附件响应格式无效");
  }

  let url: URL;
  try {
    url = new URL(value.browser_download_url);
  } catch {
    throw new Error(`Gitee 附件 ${value.name} 的下载地址无效`);
  }
  if (url.protocol !== "https:" || url.hostname !== "gitee.com") {
    throw new Error(`Gitee 附件 ${value.name} 必须使用 gitee.com HTTPS 地址`);
  }

  return {
    browser_download_url: value.browser_download_url,
    id: Number(value.id),
    name: value.name,
    size: Number(value.size),
  };
}

function updaterAssetName(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("更新清单包含无效下载地址");
  }
  const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  if (!name) throw new Error("更新清单下载地址缺少文件名");
  return name;
}

export function createGiteeUpdaterManifest(
  value: unknown,
  attachmentValues: unknown,
): GiteeUpdaterManifestResult {
  if (!isRecord(value)) throw new Error("更新清单格式无效");
  const manifest = value as UpdaterManifest;
  if (!isRecord(manifest.platforms)) {
    throw new Error("更新清单缺少 platforms 对象");
  }
  if (!Array.isArray(attachmentValues)) {
    throw new Error("Gitee Release 附件列表格式无效");
  }

  const attachments = attachmentValues.map(parseAttachment);
  const attachmentUrls = new Map<string, string>();
  attachments.forEach((attachment) => {
    if (attachmentUrls.has(attachment.name)) {
      throw new Error(`Gitee Release 存在重名附件：${attachment.name}`);
    }
    attachmentUrls.set(attachment.name, attachment.browser_download_url);
  });

  const platforms: Record<string, unknown> = {};
  const normalizedKeys: string[] = [];
  Object.entries(manifest.platforms).forEach(([key, value]) => {
    if (!isRecord(value)) {
      platforms[key] = value;
      return;
    }

    const platform = value as UpdaterPlatform;
    if (typeof platform.url !== "string") {
      platforms[key] = value;
      return;
    }
    const assetName = updaterAssetName(platform.url);
    const downloadUrl = attachmentUrls.get(assetName);
    if (!downloadUrl) {
      throw new Error(`Gitee Release 缺少更新附件：${assetName}`);
    }
    platforms[key] = { ...value, url: downloadUrl };
    normalizedKeys.push(key);
  });

  return {
    manifest: { ...value, platforms },
    normalizedKeys,
  };
}

class GiteeReleaseClient {
  private readonly apiBase: string;

  constructor(
    private readonly accessToken: string,
    owner: string,
    repository: string,
  ) {
    this.apiBase = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  private authenticatedUrl(path: string) {
    const url = new URL(`${this.apiBase}${path}`);
    url.searchParams.set("access_token", this.accessToken);
    return url;
  }

  private form(fields: Record<string, string>) {
    const form = new FormData();
    form.append("access_token", this.accessToken);
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    return form;
  }

  private async responseJson(
    response: Response,
    expectedStatus: number,
    label: string,
  ) {
    const text = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${label}失败（HTTP ${response.status}）：${text.slice(0, 500)}`,
      );
    }
    return parseJson(text, label);
  }

  async releaseByTag(tag: string) {
    const response = await fetch(
      this.authenticatedUrl(`/releases/tags/${encodeURIComponent(tag)}`),
    );
    if (response.status === 404) return null;
    return parseGiteeReleaseLookup(
      await this.responseJson(response, 200, "查询 Gitee Release"),
    );
  }

  async createOrUpdateRelease(options: {
    body: string;
    name: string;
    prerelease: boolean;
    tag: string;
    targetCommitish: string;
  }) {
    const existing = await this.releaseByTag(options.tag);
    const fields = {
      body: options.body,
      name: options.name,
      prerelease: String(options.prerelease),
      tag_name: options.tag,
    };
    if (existing) {
      const response = await fetch(`${this.apiBase}/releases/${existing.id}`, {
        body: this.form(fields),
        method: "PATCH",
      });
      return parseRelease(
        await this.responseJson(response, 200, "更新 Gitee Release"),
      );
    }

    const response = await fetch(`${this.apiBase}/releases`, {
      body: this.form({
        ...fields,
        target_commitish: options.targetCommitish,
      }),
      method: "POST",
    });
    return parseRelease(
      await this.responseJson(response, 201, "创建 Gitee Release"),
    );
  }

  async attachments(releaseId: number) {
    const response = await fetch(
      this.authenticatedUrl(
        `/releases/${releaseId}/attach_files?per_page=100&direction=asc`,
      ),
    );
    const value = await this.responseJson(
      response,
      200,
      "查询 Gitee Release 附件",
    );
    if (!Array.isArray(value)) {
      throw new Error("Gitee Release 附件列表格式无效");
    }
    return value.map(parseAttachment);
  }

  async uploadAttachment(
    releaseId: number,
    path: string,
    name = basename(path),
  ) {
    const label = `上传 Gitee 附件 ${name}`;
    console.log(`${label}...`);
    const process = Bun.spawn(
      [
        "curl",
        "--silent",
        "--show-error",
        "--request",
        "POST",
        "--connect-timeout",
        "30",
        "--max-time",
        "300",
        "--form-string",
        `access_token=${this.accessToken}`,
        "--form",
        `file=@${path};filename=${name}`,
        "--write-out",
        "\n%{http_code}",
        `${this.apiBase}/releases/${releaseId}/attach_files`,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [output, errorOutput, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${label}失败（curl ${exitCode}）：${errorOutput.trim().slice(0, 500)}`,
      );
    }
    return parseAttachment(parseCurlJsonResponse(output, 201, label));
  }
}

async function ensureAttachments(
  client: GiteeReleaseClient,
  releaseId: number,
  assetsDirectory: string,
) {
  const existing = await client.attachments(releaseId);
  const byName = new Map(
    existing.map((attachment) => [attachment.name, attachment]),
  );
  const assetPaths = readdirSync(assetsDirectory)
    .map((name) => resolve(assetsDirectory, name))
    .filter(
      (path) => statSync(path).isFile() && basename(path) !== "latest.json",
    )
    .sort(
      (left, right) =>
        statSync(left).size - statSync(right).size ||
        basename(left).localeCompare(basename(right)),
    );

  for (const path of assetPaths) {
    const name = basename(path);
    const current = byName.get(name);
    if (current) {
      const localSize = statSync(path).size;
      if (current.size !== localSize) {
        throw new Error(
          `Gitee Release 附件 ${name} 已存在但尺寸不同，拒绝覆盖不可变版本`,
        );
      }
      continue;
    }
    const uploaded = await client.uploadAttachment(releaseId, path);
    byName.set(uploaded.name, uploaded);
    console.log(`Gitee 附件已上传：${uploaded.name}`);
  }
  return [...byName.values()];
}

async function ensureLatestManifest(
  client: GiteeReleaseClient,
  releaseId: number,
  path: string,
  attachments: GiteeAttachment[],
) {
  const current = attachments.find(
    (attachment) => attachment.name === "latest.json",
  );
  if (!current) return client.uploadAttachment(releaseId, path, "latest.json");

  const response = await fetch(current.browser_download_url);
  if (!response.ok) {
    throw new Error(
      `下载已有 Gitee latest.json 失败（HTTP ${response.status}）`,
    );
  }
  const remote = await response.text();
  const local = readFileSync(path, "utf8");
  if (remote !== local) {
    throw new Error("Gitee latest.json 已存在但内容不同，拒绝覆盖不可变版本");
  }
  return current;
}

async function publishGiteeRelease() {
  const [
    releaseTag,
    targetCommitish,
    releaseNotesPath,
    assetsDirectory,
    sourceManifestPath,
    outputManifestPath,
  ] = process.argv.slice(2);
  if (
    !releaseTag ||
    !targetCommitish ||
    !releaseNotesPath ||
    !assetsDirectory ||
    !sourceManifestPath ||
    !outputManifestPath
  ) {
    throw new Error(
      "用法：publish-gitee-release <tag> <commit> <notes> <assets-dir> <source-manifest> <output-manifest>",
    );
  }
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(releaseTag)
  ) {
    throw new Error(`版本标签“${releaseTag}”格式无效`);
  }

  const accessToken = process.env.GITEE_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error("缺少 GITEE_ACCESS_TOKEN");
  const owner = process.env.GITEE_OWNER?.trim() || "Max0897";
  const repository = process.env.GITEE_REPOSITORY?.trim() || "FineShell";
  const client = new GiteeReleaseClient(accessToken, owner, repository);
  const release = await client.createOrUpdateRelease({
    body: readFileSync(releaseNotesPath, "utf8"),
    name: `FineShell ${releaseTag}`,
    prerelease: releaseTag.includes("-"),
    tag: releaseTag,
    targetCommitish,
  });
  const attachments = await ensureAttachments(
    client,
    release.id,
    resolve(assetsDirectory),
  );
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  const normalized = createGiteeUpdaterManifest(sourceManifest, attachments);
  writeFileSync(
    outputManifestPath,
    `${JSON.stringify(normalized.manifest, null, 2)}\n`,
    "utf8",
  );
  await ensureLatestManifest(
    client,
    release.id,
    outputManifestPath,
    attachments,
  );
  console.log(
    `Gitee Release ${releaseTag} 已同步：${normalized.normalizedKeys.join(", ")}`,
  );
}

if (import.meta.main) {
  publishGiteeRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
