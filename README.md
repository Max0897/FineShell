# FineShell

FineShell 是一个使用 Tauri 2、React、TypeScript 和 Arco Design 构建的桌面 SSH 客户端原型。

当前已完成真实密码和私钥 SSH 连接、远程 PTY、多标签终端、连接状态管理、基础 SFTP 文件管理、系统凭据库存储和三面板工作区。后续功能与优先级见 `TODO.md`。

## 开发命令

```bash
bun install
bun run build
bun test
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
bun run tauri dev
```

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
- 已保存主机支持 SHA256 指纹预校验；首次成功连接后会记录服务器指纹。
- 当前尚未实现首次连接指纹确认对话框，连接不可信服务器前应手动填写已核验的指纹。

## 文档

- `FEATURES.md`：FinalShell 功能分析和产品范围。
- `TODO.md`：当前完成情况、待办列表和阶段计划。
