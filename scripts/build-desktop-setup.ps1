param(
    [Parameter(Mandatory)][string]$Version,
    [string]$InnoCompiler
)

$ErrorActionPreference = 'Stop'
if ($Version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw "Invalid Cooper Desktop version: $Version"
}

$repo = Split-Path -Parent $PSScriptRoot
if (-not $InnoCompiler) {
    $InnoCompiler = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
    if (-not $InnoCompiler) { $InnoCompiler = Join-Path $repo 'dist/tools/inno-7/ISCC.exe' }
}
$InnoCompiler = (Resolve-Path -LiteralPath $InnoCompiler).Path
$cargo = (Get-Command cargo.exe -ErrorAction SilentlyContinue).Source
if (-not $cargo) { $cargo = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo/bin/cargo.exe' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$platform = & $node -p "process.platform + '-' + process.arch"
if ($LASTEXITCODE -ne 0 -or $platform -cne 'win32-x64') { throw 'Desktop Setup requires a Windows x64 build environment.' }

$output = Join-Path $repo 'dist/desktop-setup'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$output = (Resolve-Path -LiteralPath $output).Path
$stage = Join-Path $output ('stage-' + [guid]::NewGuid().ToString('N'))
$desktop = Join-Path $repo 'apps/desktop'
$sandbox = Join-Path $repo 'packages/shell-sandbox/target/release/cooper-shell-sandbox.exe'

Push-Location -LiteralPath $repo
try {
    & $cargo build --manifest-path 'packages/shell-sandbox/Cargo.toml' --locked --release
    if ($LASTEXITCODE -ne 0) { throw 'The Windows shell sandbox build failed.' }

    Push-Location -LiteralPath $desktop
    try {
        $electron = & $node -p "require('electron')"
        if ($LASTEXITCODE -ne 0) { throw 'Electron is missing. Install the repository dependencies first.' }
        & $node build.mjs
        if ($LASTEXITCODE -ne 0) { throw 'The Desktop build failed.' }
    } finally {
        Pop-Location
    }

    $electronPath = (Resolve-Path -LiteralPath $electron).Path
    Copy-Item -LiteralPath (Split-Path -Parent $electronPath) -Destination $stage -Recurse
    Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'Cooper Desktop.exe'
    $reportingDll = Join-Path $stage 'electron_wer.dll'
    if (Test-Path -LiteralPath $reportingDll) {
        Rename-Item -LiteralPath $reportingDll -NewName 'Cooper Desktop_wer.dll'
    }

    $resources = Join-Path $stage 'resources'
    $defaultApp = Join-Path $resources 'default_app.asar'
    if (Test-Path -LiteralPath $defaultApp) { Remove-Item -LiteralPath $defaultApp }
    $appRoot = Join-Path $resources 'app'
    $appDist = Join-Path $appRoot 'dist'
    New-Item -ItemType Directory -Path $appDist | Out-Null
    $manifest = @{
        name = 'cooper-desktop'
        productName = 'Cooper Desktop'
        version = $Version
        main = 'dist/main.cjs'
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), $manifest)
    $bundles = @('main.cjs', 'preload.cjs', 'renderer.js', 'index.html', 'styles.css', 'assets')
    foreach ($bundle in $bundles) {
        Copy-Item -LiteralPath (Join-Path $desktop "dist/$bundle") -Destination $appDist -Recurse
    }
    Copy-Item -LiteralPath $sandbox -Destination $resources

    & $InnoCompiler "/DCooperVersion=$Version" "/DStageDir=$stage" "/DSetupOutputDir=$output" `
        'scripts/windows/cooper-desktop-setup.iss'
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not create Cooper Desktop Setup.' }
    Get-Item -LiteralPath (Join-Path $output "CooperDesktopSetup-$Version-windows-x64.exe")
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        if ($resolvedStage -eq $stage -and (Split-Path -Parent $resolvedStage) -eq $output) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
