# FineShell

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="112" alt="FineShell logo" />
</p>

<p align="center">
  一个面向开发者和轻量运维场景的跨平台 SSH 工作台，将终端、SFTP 文件管理和服务器监控集中在同一个桌面窗口中。
</p>

<p align="center">
  <a href="https://github.com/Max0897/fineshell/actions/workflows/ci.yml"><img src="https://github.com/Max0897/fineshell/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/Max0897/fineshell/releases"><img src="https://img.shields.io/github/v/release/Max0897/fineshell?display_name=tag&sort=semver" alt="GitHub release" /></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111827" alt="React 18" />
  <img src="https://img.shields.io/badge/Rust-stable-000000?logo=rust" alt="Rust stable" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache License 2.0" /></a>
</p>

![FineShell 工作区：服务器监控、终端与 SFTP 文件管理](docs/screenshots/terminal.png)

## 核心能力

| 模块     | 已实现能力                                                   |
| ------ | ------------------------------------------------------- |
| 主机管理   | 分组与树形列表、搜索排序、连接历史、复制与回收站、配置导入导出                         |
| SSH 连接 | 密码、私钥、托管密钥和 SSH Agent 认证，SOCKS5 / HTTP CONNECT 代理，一级跳板机 |
| 连接可靠性  | SHA256 主机指纹确认、保活、自动重连、连接取消、结构化错误提示                      |
| 终端     | 多主机多会话标签、内容搜索、快捷命令、动态参数、本地 / 远程 / 动态 SOCKS5 端口转发        |
| SFTP   | 上传下载、暂停继续、取消重试、批量拖拽、复制移动、排序、权限及用户/用户组管理                 |
| 文件编辑   | 内置文本编辑、调用本地默认或指定编辑器、文件变化自动同步远端、冲突处理                     |
| 归档操作   | 远程压缩与解压、目录及多选项目打包下载，支持 `.tar.gz`、`.tar` 和 `.zip`        |
| 服务器监控  | 系统信息、CPU / 内存 / 磁盘占用与趋势、网络流量、进程管理和网络诊断                  |
| 应用设置   | 终端、文件管理、监控、连接、代理、密钥、已知主机、隐私清理及备份恢复设置                    |

## 界面预览

### 主机首页

通过分组树形表格集中管理主机，支持搜索、排序、新增主机和连接历史；

![FineShell 主机首页](docs/screenshots/home.png)

### 进程管理

查看远程进程的 CPU、内存、用户与运行时间，支持搜索、排序、自动刷新和发送结束信号。

![FineShell 进程管理](docs/screenshots/process-manager.png)

### 网络诊断

通过当前 SSH 会话执行 Ping、路由追踪，并查看远程端口监听和网络连接状态，无需安装额外 Agent。

![FineShell 网络诊断](docs/screenshots/network-diagnostics.png)

### 传输记录

集中查看文件上传、下载与同步任务的进度、速度和状态，并可暂停或取消正在执行的任务。

![FineShell 传输记录](docs/screenshots/transfer-history.png)

### 设置

在独立设置窗口中统一调整终端、快捷命令、文件管理、服务器监控、连接、代理、密钥和备份恢复选项。

![FineShell 设置](docs/screenshots/settings.png)

## 下载与安装

前往 [GitHub Releases](https://github.com/Max0897/fineshell/releases) 下载对应平台的安装包：

- macOS：Apple Silicon / Intel `.dmg`
- Linux：x64 `.AppImage` / `.deb`
- Windows：x64 `.exe`（NSIS）/ `.msi`

当前 macOS 安装包使用 ad-hoc 签名，Windows 安装包尚未配置商业代码签名证书，系统可能显示安全提示。正式分发前仍需完成 Apple 公证和 Windows 代码签名。

## 从源码运行

### 环境要求

- [Rust stable](https://www.rust-lang.org/tools/install)
- [Bun](https://bun.sh/docs/installation)，CI 当前使用 `1.3.11`
- 对应操作系统的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)

### 启动开发环境

```bash
git clone https://github.com/Max0897/fineshell.git
cd fineshell
bun install --frozen-lockfile
bun run tauri dev
```

### 构建安装包

```bash
bun run tauri build
```

## 开发与测试

```bash
# 前端单元测试、类型检查和生产构建
bun run check

# Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml --locked

# Rust 静态检查
cargo clippy --manifest-path src-tauri/Cargo.toml \
  --all-targets --all-features --locked -- -D warnings
```

需要真实服务器的集成测试默认标记为 `ignored`，仅在明确提供 `FINESHELL_LIVE_*` 环境变量时运行。测试可能在远端 `/tmp` 创建临时目录，结束后会自动清理。

<details>
<summary>运行 SFTP 在线测试</summary>

```bash
FINESHELL_LIVE_HOST_ID=<已保存主机 ID> \
FINESHELL_LIVE_ADDRESS=<主机地址> \
FINESHELL_LIVE_PORT=<SSH 端口> \
FINESHELL_LIVE_USERNAME=<用户名> \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  sftp::tests::completes_a_live_sftp_round_trip -- --ignored --exact
```

</details>

## 技术栈

| 层级    | 技术                                   |
| ----- | ------------------------------------ |
| 桌面运行时 | Tauri 2                              |
| 前端    | React 18、TypeScript、Vite、Arco Design |
| 终端    | xterm.js                             |
| 图表    | VChart                               |
| 后端    | Rust、ssh2、Tokio                      |
| 凭据存储  | keyring / 操作系统凭据库                    |
| 工具链   | Bun、Cargo、GitHub Actions             |

前端通过版本化的 Tauri 命令与事件协议调用 Rust 后端。SSH、SFTP、文件传输和系统监控都在后端执行，前端只接收展示所需的数据与状态事件。

## 贡献

欢迎提交 Issue 和 Pull Request。开始较大改动前，建议先通过 Issue 对齐范围。

- `main` 只接收已经通过 CI 的合并结果，不直接在该分支开发。
- 提交 Pull Request 前请运行 `bun run check`、Rust 测试和 Clippy。
- 一个 Pull Request 尽量只解决一个清晰问题，并同步补充对应测试或文档。

## 版本发布

发布前需要同步修改 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本：

```bash
bun run release:check -- v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

版本标签会触发 GitHub Actions 构建 macOS、Linux 和 Windows 安装包；所有平台构建成功后，工作流才会公开对应 Release。

## 支持项目

如果 FineShell 对你有帮助，可以通过反馈问题、完善文档、贡献代码、分享项目或自愿打赏来支持它。打赏不会影响功能开放、Issue 处理或贡献者权益。

<p align="center">
  <img src="docs/donate/wechat-pay.jpg" width="220" alt="微信支付收款码" />
</p>

## 开源许可

FineShell 使用 [Apache License 2.0](LICENSE) 开源。你可以自由使用、修改和分发本项目，但需要保留许可证及相关版权声明。
