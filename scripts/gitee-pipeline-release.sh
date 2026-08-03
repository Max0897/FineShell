#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
trigger_file="$repository_root/.gitee-release-trigger.json"

test -f "$trigger_file" || {
  echo "缺少 .gitee-release-trigger.json，拒绝发布。" >&2
  exit 1
}
test -n "${GITEE_ACCESS_TOKEN:-}" || {
  echo "缺少 GITEE_ACCESS_TOKEN 流水线密钥变量。" >&2
  exit 1
}

for command_name in curl git python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Gitee Runner 缺少命令：$command_name" >&2
    exit 1
  }
done

release_directory="$(mktemp -d)"
askpass_file="$(mktemp)"
cleanup() {
  rm -rf "$release_directory"
  rm -f "$askpass_file"
}
trap cleanup EXIT

assets_directory="$release_directory/assets"
gitee_manifest="$release_directory/latest.json"
python3 "$repository_root/scripts/gitee_pipeline_release.py" \
  "$trigger_file" \
  "$assets_directory" \
  "$gitee_manifest"

cat > "$askpass_file" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'oauth2' ;;
  *) printf '%s\n' "$GITEE_ACCESS_TOKEN" ;;
esac
EOF
chmod 700 "$askpass_file"
export GIT_ASKPASS="$askpass_file"
export GIT_TERMINAL_PROMPT=0

ota_directory="$release_directory/ota"
gitee_repository="https://gitee.com/${GITEE_OWNER:-Max0897}/${GITEE_REPOSITORY:-FineShell}.git"
if git ls-remote --exit-code --heads "$gitee_repository" refs/heads/ota >/dev/null 2>&1; then
  git clone --depth 1 --branch ota --single-branch \
    "$gitee_repository" "$ota_directory"
  git -C "$ota_directory" remote rename origin gitee
else
  mkdir -p "$ota_directory"
  git -C "$ota_directory" init -b ota
  git -C "$ota_directory" remote add gitee "$gitee_repository"
fi

install -m 644 "$gitee_manifest" "$ota_directory/latest.json"
git -C "$ota_directory" config user.name "FineShell Release"
git -C "$ota_directory" config user.email "pipeline@gitee.com"
git -C "$ota_directory" add latest.json

if git -C "$ota_directory" diff --cached --quiet; then
  echo "Gitee OTA 清单已经是最新版本。"
  exit 0
fi

release_tag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag"])' "$trigger_file")"
git -C "$ota_directory" commit -m "发布 $release_tag 更新清单"
git -C "$ota_directory" push gitee HEAD:refs/heads/ota
echo "Gitee OTA 清单已发布：$release_tag"
