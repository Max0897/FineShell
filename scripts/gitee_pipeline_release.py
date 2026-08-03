#!/usr/bin/env python3
"""Publish an existing GitHub Release through a Gitee pipeline."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, unquote, urlparse
from urllib.request import Request, urlopen


TAG_PATTERN = re.compile(r"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
COMMIT_PATTERN = re.compile(r"^[0-9a-fA-F]{7,40}$")
REQUIRED_PLATFORM_GROUPS = (
    ("macOS Apple Silicon", ("darwin-aarch64-app", "darwin-aarch64")),
    ("macOS Intel", ("darwin-x86_64-app", "darwin-x86_64")),
    ("Linux x64", ("linux-x86_64-deb",)),
    ("Linux ARM64", ("linux-aarch64-deb",)),
    (
        "Windows x64",
        ("windows-x86_64-nsis", "windows-x86_64-msi", "windows-x86_64"),
    ),
    ("Windows ARM64", ("windows-aarch64-nsis", "windows-aarch64")),
)


class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReleaseTrigger:
    tag: str
    commit: str
    github_repository: str


@dataclass(frozen=True)
class GitHubAsset:
    name: str
    size: int
    download_url: str


@dataclass(frozen=True)
class GiteeAttachment:
    name: str
    size: int
    download_url: str


def _record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReleaseError(f"{label}格式无效")
    return value


def load_trigger(path: Path) -> ReleaseTrigger:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"读取发布触发文件失败：{error}") from error
    record = _record(value, "发布触发文件")
    tag = record.get("tag")
    commit = record.get("commit")
    repository = record.get("github_repository")
    if not isinstance(tag, str) or not TAG_PATTERN.fullmatch(tag):
        raise ReleaseError("发布触发文件包含无效版本标签")
    if not isinstance(commit, str) or not COMMIT_PATTERN.fullmatch(commit):
        raise ReleaseError("发布触发文件包含无效提交 ID")
    if (
        not isinstance(repository, str)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
    ):
        raise ReleaseError("发布触发文件包含无效 GitHub 仓库")
    return ReleaseTrigger(tag=tag, commit=commit, github_repository=repository)


def request_json(
    url: str,
    *,
    method: str = "GET",
    fields: dict[str, str] | None = None,
    expected_status: tuple[int, ...] = (200,),
    label: str,
    headers: dict[str, str] | None = None,
) -> Any:
    data = urlencode(fields).encode("utf-8") if fields is not None else None
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "FineShell-Gitee-Pipeline",
        **(headers or {}),
    }
    request = Request(
        url,
        data=data,
        headers=request_headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=90) as response:
            status = response.status
            body = response.read().decode("utf-8")
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise ReleaseError(
            f"{label}失败（HTTP {error.code}）：{body[:500]}"
        ) from error
    except URLError as error:
        raise ReleaseError(f"{label}失败：{error.reason}") from error
    if status not in expected_status:
        raise ReleaseError(f"{label}失败（HTTP {status}）：{body[:500]}")
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise ReleaseError(f"{label}返回了无效 JSON") from error


def load_github_release(trigger: ReleaseTrigger) -> tuple[str, list[GitHubAsset]]:
    headers: dict[str, str] = {}
    github_token = os.environ.get("GITHUB_TOKEN", "").strip()
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    release = _record(
        request_json(
            "https://api.github.com/repos/"
            f"{trigger.github_repository}/releases/tags/{quote(trigger.tag, safe='')}",
            label="查询 GitHub Release",
            headers=headers,
        ),
        "GitHub Release",
    )
    if release.get("draft") is True:
        raise ReleaseError("GitHub Release 仍是草稿，拒绝开始 Gitee 发布")
    if release.get("tag_name") != trigger.tag:
        raise ReleaseError("GitHub Release 标签与发布触发文件不一致")
    body = release.get("body")
    if not isinstance(body, str):
        body = ""
    values = release.get("assets")
    if not isinstance(values, list):
        raise ReleaseError("GitHub Release 缺少附件列表")

    assets: list[GitHubAsset] = []
    names: set[str] = set()
    for value in values:
        asset = _record(value, "GitHub Release 附件")
        name = asset.get("name")
        size = asset.get("size")
        download_url = asset.get("browser_download_url")
        if (
            not isinstance(name, str)
            or not name
            or Path(name).name != name
            or not isinstance(size, int)
            or size <= 0
            or not isinstance(download_url, str)
            or urlparse(download_url).scheme != "https"
        ):
            raise ReleaseError("GitHub Release 附件格式无效")
        if name in names:
            raise ReleaseError(f"GitHub Release 存在重名附件：{name}")
        names.add(name)
        assets.append(GitHubAsset(name=name, size=size, download_url=download_url))
    if "latest.json" not in names:
        raise ReleaseError("GitHub Release 缺少 latest.json")
    return body, assets


def parse_gitee_attachment(value: Any) -> GiteeAttachment:
    record = _record(value, "Gitee Release 附件")
    name = record.get("name")
    size = record.get("size")
    download_url = record.get("browser_download_url")
    if (
        not isinstance(name, str)
        or not name
        or not isinstance(size, int)
        or size < 0
        or not isinstance(download_url, str)
    ):
        raise ReleaseError("Gitee Release 附件响应格式无效")
    parsed = urlparse(download_url)
    if parsed.scheme != "https" or parsed.hostname != "gitee.com":
        raise ReleaseError(f"Gitee 附件 {name} 必须使用 gitee.com HTTPS 地址")
    return GiteeAttachment(name=name, size=size, download_url=download_url)


class GiteeClient:
    def __init__(self, token: str, owner: str, repository: str) -> None:
        self.token = token
        self.api_base = (
            "https://gitee.com/api/v5/repos/"
            f"{quote(owner, safe='')}/{quote(repository, safe='')}"
        )

    def _authenticated_url(self, path: str) -> str:
        separator = "&" if "?" in path else "?"
        return f"{self.api_base}{path}{separator}{urlencode({'access_token': self.token})}"

    def release_by_tag(self, tag: str) -> dict[str, Any] | None:
        value = request_json(
            self._authenticated_url(f"/releases/tags/{quote(tag, safe='')}"),
            label="查询 Gitee Release",
        )
        if value is None:
            return None
        release = _record(value, "Gitee Release")
        if not isinstance(release.get("id"), int):
            raise ReleaseError("Gitee Release 响应缺少有效 ID")
        return release

    def create_or_update_release(
        self,
        *,
        tag: str,
        commit: str,
        body: str,
    ) -> int:
        existing = self.release_by_tag(tag)
        fields = {
            "access_token": self.token,
            "body": body,
            "name": f"FineShell {tag}",
            "prerelease": str("-" in tag).lower(),
            "tag_name": tag,
        }
        if existing is not None:
            release_id = existing["id"]
            value = request_json(
                f"{self.api_base}/releases/{release_id}",
                method="PATCH",
                fields=fields,
                label="更新 Gitee Release",
            )
        else:
            value = request_json(
                f"{self.api_base}/releases",
                method="POST",
                fields={**fields, "target_commitish": commit},
                expected_status=(201,),
                label="创建 Gitee Release",
            )
        release = _record(value, "Gitee Release")
        release_id = release.get("id")
        if not isinstance(release_id, int):
            raise ReleaseError("Gitee Release 响应缺少有效 ID")
        return release_id

    def attachments(self, release_id: int) -> list[GiteeAttachment]:
        value = request_json(
            self._authenticated_url(
                f"/releases/{release_id}/attach_files?per_page=100&direction=asc"
            ),
            label="查询 Gitee Release 附件",
        )
        if not isinstance(value, list):
            raise ReleaseError("Gitee Release 附件列表格式无效")
        return [parse_gitee_attachment(item) for item in value]

    def upload_attachment(self, release_id: int, path: Path) -> GiteeAttachment:
        label = f"上传 Gitee 附件 {path.name}"
        print(f"{label}...", flush=True)
        process = subprocess.run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--request",
                "POST",
                "--connect-timeout",
                "30",
                "--max-time",
                "1800",
                "--form-string",
                f"access_token={self.token}",
                "--form",
                f"file=@{path};filename={path.name}",
                "--write-out",
                "\n%{http_code}",
                f"{self.api_base}/releases/{release_id}/attach_files",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if process.returncode != 0:
            raise ReleaseError(
                f"{label}失败（curl {process.returncode}）：{process.stderr[:500]}"
            )
        body, separator, status_text = process.stdout.rpartition("\n")
        if not separator or status_text.strip() != "201":
            raise ReleaseError(
                f"{label}失败（HTTP {status_text.strip() or '未知'}）：{body[:500]}"
            )
        try:
            return parse_gitee_attachment(json.loads(body))
        except json.JSONDecodeError as error:
            raise ReleaseError(f"{label}返回了无效 JSON") from error


def download_asset(asset: GitHubAsset, directory: Path) -> Path:
    destination = directory / asset.name
    temporary = destination.with_suffix(f"{destination.suffix}.part")
    process = subprocess.run(
        [
            "curl",
            "--location",
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "4",
            "--retry-delay",
            "3",
            "--connect-timeout",
            "30",
            "--max-time",
            "1800",
            "--output",
            str(temporary),
            asset.download_url,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise ReleaseError(
            f"下载 GitHub 附件 {asset.name} 失败（curl {process.returncode}）："
            f"{process.stderr[:500]}"
        )
    actual_size = temporary.stat().st_size
    if actual_size != asset.size:
        temporary.unlink(missing_ok=True)
        raise ReleaseError(
            f"GitHub 附件 {asset.name} 大小不一致：期望 {asset.size}，实际 {actual_size}"
        )
    temporary.replace(destination)
    print(f"GitHub 附件已下载：{asset.name}", flush=True)
    return destination


def updater_asset_name(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ReleaseError("更新清单包含无效下载地址")
    name = unquote(parsed.path.rsplit("/", 1)[-1])
    if not name:
        raise ReleaseError("更新清单下载地址缺少文件名")
    return name


def create_gitee_updater_manifest(
    source: Any,
    attachments: list[GiteeAttachment],
    tag: str,
) -> dict[str, Any]:
    manifest = _record(source, "更新清单")
    if manifest.get("version") != tag.removeprefix("v"):
        raise ReleaseError("更新清单版本与发布标签不一致")
    platforms = _record(manifest.get("platforms"), "更新清单 platforms")
    attachment_urls: dict[str, str] = {}
    for attachment in attachments:
        if attachment.name in attachment_urls:
            raise ReleaseError(f"Gitee Release 存在重名附件：{attachment.name}")
        attachment_urls[attachment.name] = attachment.download_url

    normalized_platforms: dict[str, Any] = {}
    for key, value in platforms.items():
        platform = _record(value, f"更新清单平台 {key}")
        url = platform.get("url")
        signature = platform.get("signature")
        if not isinstance(url, str) or not isinstance(signature, str) or not signature:
            raise ReleaseError(f"更新清单平台 {key} 缺少下载地址或签名")
        name = updater_asset_name(url)
        gitee_url = attachment_urls.get(name)
        if gitee_url is None:
            raise ReleaseError(f"Gitee Release 缺少更新附件：{name}")
        normalized_platforms[key] = {**platform, "url": gitee_url}

    for label, keys in REQUIRED_PLATFORM_GROUPS:
        if not any(key in normalized_platforms for key in keys):
            raise ReleaseError(f"更新清单缺少 {label}")
    return {**manifest, "platforms": normalized_platforms}


def publish(trigger_path: Path, assets_directory: Path, output_path: Path) -> None:
    token = os.environ.get("GITEE_ACCESS_TOKEN", "").strip()
    if not token:
        raise ReleaseError("缺少 GITEE_ACCESS_TOKEN 流水线密钥变量")
    owner = os.environ.get("GITEE_OWNER", "Max0897").strip()
    repository = os.environ.get("GITEE_REPOSITORY", "FineShell").strip()
    trigger = load_trigger(trigger_path)
    release_body, github_assets = load_github_release(trigger)
    assets_directory.mkdir(parents=True, exist_ok=True)

    client = GiteeClient(token, owner, repository)
    release_id = client.create_or_update_release(
        tag=trigger.tag,
        commit=trigger.commit,
        body=release_body,
    )
    existing = {item.name: item for item in client.attachments(release_id)}
    source_manifest_path: Path | None = None

    for asset in sorted(github_assets, key=lambda item: (item.size, item.name)):
        if asset.name == "latest.json":
            source_manifest_path = download_asset(asset, assets_directory)
            continue
        current = existing.get(asset.name)
        if current is not None:
            if current.size != asset.size:
                raise ReleaseError(
                    f"Gitee Release 附件 {asset.name} 已存在但尺寸不同，拒绝覆盖"
                )
            print(f"Gitee 附件已存在，跳过：{asset.name}", flush=True)
            continue
        path = download_asset(asset, assets_directory)
        uploaded = client.upload_attachment(release_id, path)
        if uploaded.size != asset.size:
            raise ReleaseError(f"Gitee 附件 {asset.name} 上传后大小不一致")
        existing[uploaded.name] = uploaded
        print(f"Gitee 附件已上传：{uploaded.name}", flush=True)

    if source_manifest_path is None:
        raise ReleaseError("GitHub Release 缺少 latest.json")
    try:
        source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"读取 GitHub 更新清单失败：{error}") from error
    manifest = create_gitee_updater_manifest(
        source_manifest,
        list(existing.values()),
        trigger.tag,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Gitee Release {trigger.tag} 与 OTA 清单已生成。", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("trigger", type=Path)
    parser.add_argument("assets_directory", type=Path)
    parser.add_argument("output_manifest", type=Path)
    arguments = parser.parse_args()
    try:
        publish(
            arguments.trigger,
            arguments.assets_directory,
            arguments.output_manifest,
        )
    except ReleaseError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
