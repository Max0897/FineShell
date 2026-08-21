# 构建体积分析

FineShell 提供三类可重复执行的体积分析，报告统一写入 `reports/size/`，该目录不会提交到 Git，也不会进入正式安装包。

## 前端依赖

```bash
bun run analyze:frontend
```

执行后打开 `reports/size/frontend-bundle.html`，可以按 treemap 查看各依赖、源码模块的原始体积、gzip 体积和 brotli 体积。

## Rust 二进制

首次使用先安装 `cargo-bloat`：

```bash
cargo install cargo-bloat
bun run analyze:rust
```

输出内容：

- `rust-crates.txt`：各 crate 对最终二进制体积的贡献。
- `rust-functions.txt`：体积最大的函数列表。
- `rust-duplicates.txt`：Cargo 依赖树中的重复版本。
- `rust-features.txt`：最终启用的 Cargo feature 依赖链。

Rust 体积分析使用独立的 `size-analysis` profile。该 profile 继承正式发布的 LTO 与代码生成设置，但不会剥离符号，因此 `cargo-bloat` 仍能定位到具体 crate 和函数。正式安装包继续使用 `release` profile，并会剥离符号以减小体积。

## 构建产物

```bash
bun run analyze:artifacts
```

该命令扫描当前已有的 `dist`、Release 可执行文件和 `src-tauri/target/release/bundle`，生成 `artifacts.md`。它不会自动执行耗时较长的 Tauri 打包；需要对最新安装包分析时，应先完成一次正式构建。

## 完整分析

安装 `cargo-bloat` 后运行：

```bash
bun run analyze:size
```

完整分析会依次生成前端、Rust 和构建产物报告。日常排查建议先从前端 treemap 与 Rust crate 排行定位大依赖，再决定是否替换依赖或调整 feature，避免仅凭源码行数判断安装包体积。
