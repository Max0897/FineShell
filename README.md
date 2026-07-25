# FineShell

FineShell 是一个使用 Tauri 2、React、TypeScript 和 Arco Design 构建的桌面 SSH 客户端原型。

当前已完成真实密码、私钥和 SSH Agent 连接、SOCKS5 与 HTTP CONNECT 代理、一级跳板机、本地/远程/动态 SOCKS5 端口转发、主机指纹确认、SSH 保活与自动重连、远程 PTY、带内容搜索、动态参数快捷命令和固定主机首页的多标签终端、支持暂停取消、批量拖拽、远程复制移动、压缩解压、目录打包下载和文本安全编辑的 SFTP 文件管理、服务器监控、系统凭据库存储、三面板工作区和独立全局设置窗口。后续功能与优先级见 `TODO.md`。

## 开发命令

```bash
bun install
bun run build
bun test
bun run test:components
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
bun run tauri dev
```

## 分支策略

- `main` 只接收已经通过 CI 的合并结果，不直接在该分支开发。
- 新功能和常规开发使用 `feature/<名称>`，问题修复使用 `fix/<名称>`，不使用 `codex/` 前缀。
- 开发完成后向 `main` 创建 Pull Request；CI 会自动执行前端测试、构建、Rust 测试和 Clippy。

## 版本发布

发布前需要同步修改 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本。版本合并到 `main` 后，推送对应标签即可触发安装包构建和 GitHub Release：

```bash
bun run release:check -- v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

也可以从 GitHub Actions 的 `Release` 工作流手动运行，但必须选择 `main` 并输入与应用版本一致的标签。工作流会生成 macOS Apple Silicon/Intel DMG、Linux AppImage/DEB 以及 Windows NSIS/MSI；全部构建成功后才会公开 Release。

当前 macOS 包使用 ad-hoc 签名，Windows 包未配置商业代码签名证书，安装时可能出现系统安全提示。正式分发前应配置 Apple 公证和 Windows 代码签名。

可选的 SFTP 在线测试会使用系统凭据库中已保存的主机密码，并在远端 `/tmp` 创建和清理随机测试目录：

```bash
FINESHELL_LIVE_HOST_ID=<已保存主机 ID> \
FINESHELL_LIVE_ADDRESS=<主机地址> \
FINESHELL_LIVE_PORT=<SSH 端口> \
FINESHELL_LIVE_USERNAME=<用户名> \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  sftp::tests::completes_a_live_sftp_round_trip -- --ignored --exact
```

## 安全说明

- 主机元数据保存在本地 `localStorage`。
- SSH 密码通过 Rust 后端写入操作系统凭据库，不保存在 `localStorage`。
- 私钥只保存本地文件路径，私钥口令写入操作系统凭据库。
- SFTP 复用保存的主机配置和操作系统凭据库，不向前端返回密码。
- 首次连接会在发送认证凭据前显示 SHA256 主机指纹，确认后记录；指纹变化时会阻止静默连接并显示新旧值。

## 文档

- `FEATURES.md`：FinalShell 功能分析和产品范围。
- `TODO.md`：当前完成情况、待办列表和阶段计划。
