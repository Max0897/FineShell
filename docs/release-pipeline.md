# 发布流水线

FineShell 使用 GitHub Actions 完成正式版本发布：

1. 校验版本标签、应用版本和 `CHANGELOG.md` 发布说明。
2. 创建 GitHub Draft Release。
3. 并行构建 macOS、Linux 和 Windows 安装包及更新签名。
4. 规范化并校验 `latest.json` 中的 GitHub Release 下载地址。
5. 上传最终更新清单，写入发布说明并公开 GitHub Release。

客户端通过 GitHub Releases 的 `latest.json` 检查更新，并由 Tauri Updater 校验安装包签名。

## GitHub 配置

GitHub Actions 需要配置仓库密钥 `TAURI_SIGNING_PRIVATE_KEY`，用于生成可由客户端验证的更新签名。工作流使用仓库提供的 `GITHUB_TOKEN` 创建 Release 和上传构建产物，无需额外访问令牌。

## 发布方式

推送符合 `v*` 格式的版本标签会自动触发发布，也可以在 GitHub Actions 中手动运行 Release 工作流并填写版本标签。版本标签必须与 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本一致，且对应提交必须属于 `main`。

## 失败重试

- 构建任务失败：修复后发布新版本；未公开的 Draft Release 可以手动删除。
- 单个平台偶发失败：在 GitHub Actions 中重跑失败任务。
- 更新清单校验失败：检查构建矩阵是否生成了全部平台包，以及下载地址是否指向当前版本的 GitHub Release。
