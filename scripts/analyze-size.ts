import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type AnalysisTarget = "all" | "frontend" | "rust" | "artifacts";

const projectRoot = resolve(import.meta.dir, "..");
const reportRoot = resolve(projectRoot, "reports/size");
const cargoManifest = resolve(projectRoot, "src-tauri/Cargo.toml");
const cargoRoot = resolve(projectRoot, "src-tauri");

function run(command: string, args: string[], cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      CARGO_TERM_COLOR: "never",
      NO_COLOR: "1",
    },
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(details || `${command} 执行失败（退出码 ${result.status}）`);
  }

  return result.stdout.trim();
}

function writeReport(filename: string, contents: string) {
  const path = resolve(reportRoot, filename);
  writeFileSync(path, `${contents.trim()}\n`);
  console.log(`已生成 ${relative(projectRoot, path)}`);
}

function analyzeFrontend() {
  console.log("正在分析前端依赖体积...");
  run("bunx", ["vite", "build", "--mode", "analyze"]);
  console.log("已生成 reports/size/frontend-bundle.html");
}

function analyzeRust() {
  console.log("正在分析 Rust 重复依赖...");
  writeReport(
    "rust-duplicates.txt",
    run("cargo", ["tree", "--manifest-path", cargoManifest, "--duplicates"]),
  );
  writeReport(
    "rust-features.txt",
    run("cargo", [
      "tree",
      "--manifest-path",
      cargoManifest,
      "--edges",
      "features",
    ]),
  );

  const availability = spawnSync("cargo", ["bloat", "--version"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (availability.status !== 0) {
    throw new Error(
      "未安装 cargo-bloat。请先运行 `cargo install cargo-bloat`，再执行 `bun run analyze:rust`。",
    );
  }

  console.log("正在分析 Rust crate 体积（首次运行可能需要重新编译）...");
  writeReport(
    "rust-crates.txt",
    run(
      "cargo",
      ["bloat", "--profile", "size-analysis", "--crates"],
      cargoRoot,
    ),
  );
  writeReport(
    "rust-functions.txt",
    run(
      "cargo",
      ["bloat", "--profile", "size-analysis", "-n", "60"],
      cargoRoot,
    ),
  );
}

type Artifact = {
  path: string;
  size: number;
};

function collectFiles(path: string, artifacts: Artifact[]) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }

  if (stat.isFile()) {
    artifacts.push({ path: relative(projectRoot, path), size: stat.size });
    return;
  }

  for (const entry of readdirSync(path)) {
    collectFiles(resolve(path, entry), artifacts);
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function analyzeArtifacts() {
  const artifacts: Artifact[] = [];
  const roots = [
    resolve(projectRoot, "dist"),
    resolve(projectRoot, "src-tauri/target/release/fineshell"),
    resolve(projectRoot, "src-tauri/target/release/fineshell.exe"),
    resolve(projectRoot, "src-tauri/target/release/bundle"),
  ];
  roots.forEach((path) => collectFiles(path, artifacts));
  artifacts.sort((left, right) => right.size - left.size);

  const total = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  const rows = artifacts
    .slice(0, 100)
    .map(
      (artifact) =>
        `| ${artifact.path.replaceAll("|", "\\|")} | ${formatBytes(artifact.size)} | ${artifact.size} |`,
    );
  const report = [
    "# FineShell 构建产物体积",
    "",
    `- 扫描文件：${artifacts.length} 个`,
    `- 文件总计：${formatBytes(total)}`,
    "- 说明：这里只统计当前已经存在的构建产物，不会自动执行 Tauri 打包。",
    "",
    "## 最大的 100 个文件",
    "",
    "| 文件 | 体积 | 字节 |",
    "| --- | ---: | ---: |",
    ...(rows.length ? rows : ["| 暂无构建产物 | - | 0 |"]),
  ].join("\n");

  writeReport("artifacts.md", report);
}

function parseTarget(value: string | undefined): AnalysisTarget {
  if (
    value === "frontend" ||
    value === "rust" ||
    value === "artifacts" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("分析目标必须是 all、frontend、rust 或 artifacts");
}

function main() {
  mkdirSync(reportRoot, { recursive: true });
  const target = parseTarget(process.argv[2] ?? "all");

  if (target === "all" || target === "frontend") analyzeFrontend();
  if (target === "all" || target === "artifacts") analyzeArtifacts();
  if (target === "all" || target === "rust") analyzeRust();

  console.log(`尺寸分析完成，报告目录：${relative(projectRoot, reportRoot)}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
