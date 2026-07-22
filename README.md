# FineShell

FineShell 是一个使用 Tauri 2、React、TypeScript 和 Arco Design 构建的桌面 SSH 客户端原型。

当前已完成真实密码 SSH 连接、远程 PTY、多标签终端、连接状态管理、系统凭据库存储和三面板工作区。后续功能与优先级见 `TODO.md`。

## 开发命令

```bash
bun install
bun run build
bun test
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
bun run tauri dev
```

## 安全说明

- 主机元数据保存在本地 `localStorage`。
- SSH 密码通过 Rust 后端写入操作系统凭据库，不保存在 `localStorage`。
- 已保存主机支持 SHA256 指纹预校验；首次成功连接后会记录服务器指纹。
- 当前尚未实现首次连接指纹确认对话框，连接不可信服务器前应手动填写已核验的指纹。

## 文档

- `FEATURES.md`：FinalShell 功能分析和产品范围。
- `TODO.md`：当前完成情况、待办列表和阶段计划。
