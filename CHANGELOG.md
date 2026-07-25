# 更新日志

本文件记录 FineShell 各版本的重要变更。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-07-26

### 修复

- 修复 macOS 安装包错误依赖构建机 Homebrew OpenSSL，导致安装后无法启动的问题。

### 工程

- macOS 发布构建改为静态链接 vendored OpenSSL。
- 增加 macOS 发布产物动态依赖检查，阻止包含构建机本地依赖的安装包发布。

## [0.1.0] - 2026-07-25

FineShell 的首个公开版本，将 SSH 终端、SFTP 文件管理和服务器监控整合到统一的跨平台桌面工作区。

### 下载

- macOS：Apple Silicon / Intel `.dmg`
- Linux：x64 `.AppImage` / `.deb`
- Windows：x64 `.exe`（NSIS）/ `.msi`

### 新增

- 支持密码、私钥、托管密钥和 SSH Agent 认证。
- 支持 SOCKS5、HTTP CONNECT 代理及一级跳板机连接。
- 支持多主机、多会话终端标签，以及本地、远程和动态 SOCKS5 端口转发。
- 支持 SFTP 上传下载、批量拖拽、暂停继续、取消重试、复制移动和权限管理。
- 支持远程文本文件内置编辑和本地编辑器自动同步。
- 支持远程压缩、解压和目录打包下载。
- 支持 CPU、内存、磁盘、网络流量监控，以及进程管理和网络诊断。
- 支持主机分组、连接历史、配置导入导出、自动备份、回收站和已知主机指纹管理。
- 支持终端搜索、参数化快捷命令和快捷键操作说明。
- 支持应用内检查 GitHub Release 更新并下载安装。

### 工程

- 增加前端测试、Rust 测试、Clippy 检查和 GitHub Actions 持续集成。
- 增加 macOS、Linux 和 Windows 跨平台安装包构建及签名更新清单。

### 已知限制

- macOS 安装包当前使用 ad-hoc 签名，尚未接入 Apple 公证。
- Windows 安装包尚未配置商业代码签名证书。
