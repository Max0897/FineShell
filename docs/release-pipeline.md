# 发布流水线

FineShell 将版本准备与跨平台构建拆成两个 GitHub Actions 工作流：

1. `Prepare Release` 根据 `patch`、`minor` 或 `major` 自动升级所有版本文件。
2. 工作流将 `CHANGELOG.md` 的 `Unreleased` 内容归档到新版本，并创建 `fix/release-vX.Y.Z` Pull Request。
3. 发布 PR 合并到 `main` 后，`Release` 自动校验版本和发布说明并创建 Draft Release。
4. 工作流并行构建 macOS、Linux 和 Windows 安装包及更新签名。
5. 工作流规范化并校验 `latest.json`，写入发布说明后公开 GitHub Release。

客户端通过 GitHub Releases 的 `latest.json` 检查更新，并由 Tauri Updater 校验安装包签名。

## GitHub 配置

GitHub Actions 需要配置仓库密钥 `TAURI_SIGNING_PRIVATE_KEY`，用于生成可由客户端验证的更新签名。工作流使用仓库提供的 `GITHUB_TOKEN` 创建发布 PR、Release 和构建产物，无需额外访问令牌。

仓库的 Actions 设置需要允许 GitHub Actions 创建 Pull Request。`main` 分支保护继续负责审核发布 PR，工作流不会直接向 `main` 提交。

## 日常准备

开发过程中只需将面向用户的变更记录到 `CHANGELOG.md` 顶部的 `Unreleased` 区域，不要提前修改应用版本或创建版本标签。

## 正常发布

1. 在 GitHub Actions 中运行 `Prepare Release`。
2. 选择 `patch`、`minor` 或 `major`。
3. 检查工作流创建的发布 PR，确认版本和更新日志后合并。
4. 合并会自动触发 `Release`；所有平台构建通过后 Release 自动公开。

发布 PR 会同步更新：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `CHANGELOG.md`

本地可以使用 `bun run release:prepare -- patch` 验证版本准备脚本。该命令会直接修改当前工作区，因此只能在干净的非 `main` 分支执行。

## 手动恢复

正常流程不需要手动创建 tag。自动发布未触发时，可以在 GitHub Actions 中从 `main` 手动运行 `Release` 并填写与应用版本一致的 `vX.Y.Z`；发布提交必须属于 `main`。

## 失败重试

- `Prepare Release` 失败：修正 `Unreleased` 内容或清理同名远程分支后重新运行。
- 创建发布 PR 失败：确认仓库已允许 GitHub Actions 创建 Pull Request；工作流推送的发布分支可用于手动创建 PR。
- 单个平台偶发失败：在 GitHub Actions 中重跑失败任务。
- 发布构建失败：修复后发布新版本；未公开的 Draft Release 可以手动删除。
- 更新清单校验失败：检查构建矩阵是否生成全部平台包，以及下载地址是否指向当前版本的 GitHub Release。
