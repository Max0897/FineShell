param([switch]$NoSign)

$ErrorActionPreference = "Stop"
$Target = "i686-win7-windows-msvc"
$BundleTarget = "i686-pc-windows-msvc"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Require-Command {
    param([string]$Name, [string]$InstallHint)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command '$Name'. $InstallHint"
    }
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Executable $($Arguments -join ' ')"
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The Win7 x86 installer must be built on a Windows x64 host."
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Use a Windows x64 build host so the required toolchain can cross-compile the x86 target."
}

Require-Command "rustup" "Install Rust from https://rustup.rs/."
Require-Command "bun" "Install Bun from https://bun.sh/."
Require-Command "perl" "Install Strawberry Perl for vendored OpenSSL."
Require-Command "nasm" "Install NASM and add it to PATH for vendored OpenSSL."

Push-Location $RepoRoot
try {
    Write-Host "Preparing Rust nightly with rust-src..."
    Invoke-Checked "rustup" @("toolchain", "install", "nightly", "--profile", "minimal", "--component", "rust-src")
    Invoke-Checked "rustup" @("target", "add", $BundleTarget, "--toolchain", "nightly")

    $TargetList = (& rustc +nightly --print target-list) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $TargetList -notmatch "(?m)^$([regex]::Escape($Target))$") {
        throw "The installed nightly toolchain does not provide target '$Target'."
    }

    $GeneratedDir = Join-Path $RepoRoot "src-tauri/target/win7-x86"
    New-Item -ItemType Directory -Force -Path $GeneratedDir | Out-Null
    $GeneratedConfig = Join-Path $GeneratedDir "tauri.win7-x86.generated.json"

    $Config = @{
        bundle = @{
            createUpdaterArtifacts = $false
            targets = @("nsis")
            windows = @{
                webviewInstallMode = @{
                    type = "embedBootstrapper"
                }
            }
        }
    }
    $ConfigJson = $Config | ConvertTo-Json -Depth 10
    $Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($GeneratedConfig, $ConfigJson, $Utf8WithoutBom)

    Write-Host "Installing frontend dependencies..."
    Invoke-Checked "bun" @("install", "--frozen-lockfile")
    Invoke-Checked "bun" @("run", "build")

    $PreviousToolchain = $env:RUSTUP_TOOLCHAIN
    $TargetRustFlagsName = "CARGO_TARGET_I686_WIN7_WINDOWS_MSVC_RUSTFLAGS"
    $PreviousTargetRustFlags = [Environment]::GetEnvironmentVariable($TargetRustFlagsName, "Process")
    $env:RUSTUP_TOOLCHAIN = "nightly"
    $TargetRustFlags = (($PreviousTargetRustFlags, "-C target-feature=+crt-static") -join " ").Trim()
    [Environment]::SetEnvironmentVariable($TargetRustFlagsName, $TargetRustFlags, "Process")

    try {
        Write-Host "Building FineShell for Windows 7 x86..."
        Invoke-Checked "cargo" @(
            "+nightly",
            "build",
            "--manifest-path", (Join-Path $RepoRoot "src-tauri/Cargo.toml"),
            "--target", $Target,
            "--release",
            "-Z", "build-std=std,panic_abort"
        )

        # Tauri CLI validates targets against `rustup target list` before bundling.
        # The Win7 Tier 3 target is built into rustc but is not distributed by rustup,
        # so bundle the compatible i686 binary through the standard MSVC target path.
        $CompiledDir = Join-Path $RepoRoot "src-tauri/target/$Target/release"
        $BundleBinaryDir = Join-Path $RepoRoot "src-tauri/target/$BundleTarget/release"
        New-Item -ItemType Directory -Force -Path $BundleBinaryDir | Out-Null
        Copy-Item -LiteralPath (Join-Path $CompiledDir "fineshell.exe") -Destination (Join-Path $BundleBinaryDir "fineshell.exe") -Force

        $Arguments = @("tauri", "bundle")
        if ($NoSign) {
            $Arguments += "--no-sign"
        }
        $Arguments += @(
            "--target", $BundleTarget,
            "--bundles", "nsis",
            "--config", $GeneratedConfig
        )

        Write-Host "Bundling FineShell Windows 7 x86 installer..."
        Invoke-Checked "bun" $Arguments
    } finally {
        $env:RUSTUP_TOOLCHAIN = $PreviousToolchain
        [Environment]::SetEnvironmentVariable($TargetRustFlagsName, $PreviousTargetRustFlags, "Process")
    }

    $BundleDir = Join-Path $RepoRoot "src-tauri/target/$BundleTarget/release/bundle/nsis"
    $Installer = Get-ChildItem -LiteralPath $BundleDir -Filter "*.exe" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $Installer) {
        throw "The build completed but no NSIS installer was found in '$BundleDir'."
    }

    $OutputDir = Join-Path $GeneratedDir "dist"
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $Version = (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src-tauri/tauri.conf.json") | ConvertFrom-Json).version
    $OutputPath = Join-Path $OutputDir "FineShell_${Version}_windows_win7_x86-setup.exe"
    Copy-Item -LiteralPath $Installer.FullName -Destination $OutputPath -Force

    Write-Host "Win7 x86 installer: $OutputPath"
} finally {
    Pop-Location
}
