# Windows 7 32 位兼容包

FineShell 的常规 Windows 构建面向 x64 和 ARM64。Windows 7 32 位兼容包是独立产物，不进入现有 GitHub Actions 和自动更新清单。

## 构建策略

兼容包使用独立的 Windows 本机构建脚本，目标为 Rust 的 `i686-win7-windows-msvc`，并在 NSIS 安装器中内置 WebView2 Bootstrapper。普通的 `x86_64-pc-windows-gnu` 构建仍是 64 位目标，不能用于 Win7 32 位兼容包。

## 构建环境

请在 Windows 10/11 x64 构建机或虚拟机中安装：

- Visual Studio 2022 Build Tools
  - Desktop development with C++
  - MSVC x86/x64 build tools
  - Windows SDK
- Rustup
- Bun
- Strawberry Perl
- NASM
- 构建机可以访问 Rust、Bun 和 Tauri 所需的依赖源

Rust 的普通 `i686-pc-windows-msvc` 当前以 Windows 10 为最低运行环境。Win7 必须使用 Tier 3 的 `i686-win7-windows-msvc`；该目标没有随 Rustup 分发预编译标准库，构建脚本会通过 nightly 的 `build-std` 编译标准库。

Tauri CLI 会在构建前使用 `rustup target list` 校验目标，而 Rustup 不列出 Tier 3 的 Win7 目标。因此脚本会直接调用 Cargo 编译 Win7 二进制，再通过 ABI 相同的 `i686-pc-windows-msvc` 目标路径调用 Tauri `bundle` 生成 NSIS 安装器。标准目标仅用于通过打包器的架构识别，不会替换已编译的 Win7 二进制。

## WebView2 安装方式

安装器使用 Tauri 的 `embedBootstrapper` 模式。Bootstrapper 会打进 setup 安装包，但 WebView2 Runtime 本体会在安装时联网下载，因此：

- setup 体积不会因为完整 Runtime 增加数百 MB；
- 目标 Win7 机器安装时必须能访问微软 WebView2 下载服务；
- 内网或离线环境不能使用该兼容包，应另行构建包含 Fixed Runtime 的离线安装包。

## GitHub Actions 构建

在仓库 Actions 页面手动运行 `Build Windows 7 x86 Compatibility`。工作流会在 Windows Server 2022 构建机上生成 setup，并将 `FineShell-windows7-x86-setup` 作为保留 14 天的构建产物上传。

该工作流不会发布 GitHub Release，也不会修改正式版本的 Updater 清单。

## Windows 本机构建

在仓库根目录执行：

```powershell
bun run build:win7-x86
```

未配置本地代码签名时可以追加 `-NoSign`。

生成的兼容包位于：

```text
src-tauri/target/win7-x86/dist/FineShell_<version>_windows_win7_x86-setup.exe
```

## 验收要求

至少在全新 Windows 7 SP1 32 位虚拟机中验证：

1. 安装器可以启动、安装和卸载。
2. 安装器能通过内置 Bootstrapper 下载并安装 Win7 可用的 WebView2 Runtime。
3. 主窗口、设置窗口和快捷键窗口可以正常显示及关闭。
4. 密码、私钥和系统凭据库认证可以保存和读取。
5. SSH、终端、SFTP、上传下载和服务器监控正常。
6. 更新检查失败不会阻止应用启动。

Windows 7 已停止安全支持，因此该安装包只应作为明确标注的兼容产物使用。
