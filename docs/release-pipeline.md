# 发布流水线

FineShell 使用 GitHub Actions 与 Gitee 流水线协作发布：

1. GitHub Actions 完成 macOS、Linux 和 Windows 的跨平台构建。
2. GitHub Release 发布完成后，同步版本标签到 Gitee。
3. GitHub Actions 更新 Gitee 的 `gitee-release-trigger` 分支，只传递版本、提交和运行编号。
4. Gitee 流水线从 GitHub Release 下载构建产物，并在 Gitee 网络内创建或更新 Gitee Release。
5. Gitee 流水线将更新清单中的下载地址替换为 Gitee Release 附件地址，再发布到 `ota` 分支。

安装包不再由 GitHub Runner 直接上传到 Gitee OpenAPI，避免大文件跨境上传超时。

## GitHub 配置

GitHub Actions 需要以下仓库密钥：

- `GITEE_SSH_PRIVATE_KEY`：用于同步 Gitee 标签和发布触发分支。
- `GITEE_KNOWN_HOSTS`：Gitee SSH 主机指纹。

Gitee API 访问令牌不再由 GitHub Actions 使用，旧的访问令牌仓库密钥可以移除。

## Gitee 配置

流水线配置位于 `.workflow/fineshell-release.yml`，监听 `gitee-release-trigger` 分支。流水线配置以 GitHub 仓库为准，不要直接在 Gitee 页面中修改，以免两个仓库的 `main` 分支产生分叉。

在 Gitee 项目的通用变量中创建密文变量；流水线配置会通过 `variables.global` 自动关联：

- 名称：`FINESHELL_RELEASE_TOKEN`
- 类型：密文
- 权限：能够管理当前仓库的 Release，并能够推送 `ota` 分支

流水线使用 Gitee Python 3.11 构建环境，并需要提供 `bash`、`curl` 和 `git`。发布脚本只使用 Python 标准库，不需要安装项目依赖。

## 失败重试

发布脚本会根据附件名称和大小跳过已经上传的文件，因此可以安全重跑。

- GitHub 构建或 GitHub Release 失败：重跑 GitHub Release 工作流。
- Gitee 发布失败：在 Gitee 流水线中重跑失败任务。
- 需要从 GitHub 重新发送触发信号：手动运行 GitHub Release 工作流并启用“仅重新触发 Gitee 发布流水线”。

Gitee Release 完成但 OTA 清单发布失败时，直接重跑 Gitee 流水线即可，不会重复上传已经存在的安装包。
