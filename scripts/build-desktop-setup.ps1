param(
    [Parameter(Mandatory)][string]$Version,
    [string]$InnoCompiler,
    [string]$InternalBuild,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows/powershell-runtime.ps1')
. (Join-Path $PSScriptRoot 'windows/setup-build-identity.ps1')
$identity = Get-CooperSetupIdentity -Version $Version -InternalBuild $InternalBuild
$Version = $identity.Version
$productName = if ($InternalBuild) { 'Cooper Desktop Internal' } else { 'Cooper Desktop' }
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

$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repo 'dist/desktop-setup' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$output = (Resolve-Path -LiteralPath $output).Path
$outputFile = Join-Path $output "CooperDesktopSetup-$Version-windows-x64.exe"
$stage = Join-Path $output ('stage-' + [guid]::NewGuid().ToString('N'))
$desktop = Join-Path $repo 'apps/desktop'
$sandbox = Join-Path $repo 'packages/shell-sandbox/target/release/cooper-shell-sandbox.exe'
$savedBuildChannel = $env:COOPER_BUILD_CHANNEL

$buildLock = Open-CooperSetupBuildLock -Repo $repo -Product 'desktop-setup'
Push-Location -LiteralPath $repo
try {
    if ($InternalBuild -and (Test-Path -LiteralPath $outputFile)) { throw "Build already exists: $outputFile" }
    $env:COOPER_BUILD_CHANNEL = $identity.Channel
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
    Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName "$productName.exe"
    $reportingDll = Join-Path $stage 'electron_wer.dll'
    if (Test-Path -LiteralPath $reportingDll) {
        Rename-Item -LiteralPath $reportingDll -NewName "${productName}_wer.dll"
    }

    $resources = Join-Path $stage 'resources'
    $defaultApp = Join-Path $resources 'default_app.asar'
    if (Test-Path -LiteralPath $defaultApp) { Remove-Item -LiteralPath $defaultApp }
    $appRoot = Join-Path $resources 'app'
    $appDist = Join-Path $appRoot 'dist'
    New-Item -ItemType Directory -Path $appDist | Out-Null
    $manifest = @{
        name = if ($InternalBuild) { 'cooper-desktop-internal' } else { 'cooper-desktop' }
        productName = $productName
        version = $Version
        main = 'dist/main.cjs'
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), $manifest)
    $bundles = @('main.cjs', 'preload.cjs', 'renderer.js', 'index.html', 'styles.css', 'assets')
    foreach ($bundle in $bundles) {
        Copy-Item -LiteralPath (Join-Path $desktop "dist/$bundle") -Destination $appDist -Recurse
    }
    Copy-Item -LiteralPath $sandbox -Destination $resources
    Expand-CooperPowerShell -Destination (Join-Path $resources 'powershell') -Cache (Join-Path $repo 'dist/tools')

    & $InnoCompiler /Qp "/DCooperVersion=$Version" "/DCooperInternal=$($identity.InnoInternal)" "/DStageDir=$stage" "/DSetupOutputDir=$output" `
        'scripts/windows/cooper-desktop-setup.iss' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not create Cooper Desktop Setup.' }
    Get-Item -LiteralPath $outputFile
} finally {
    $env:COOPER_BUILD_CHANNEL = $savedBuildChannel
    Pop-Location
    $buildLock.Dispose()
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        if ($resolvedStage -eq $stage -and (Split-Path -Parent $resolvedStage) -eq $output) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
