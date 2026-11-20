param(
    [Parameter(Mandatory)][string]$Version,
    [string]$InnoCompiler
)

$ErrorActionPreference = 'Stop'
if ($Version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw "Invalid Cooper release version: $Version"
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
$launcher = Join-Path $repo 'apps/cli/launcher/target/release/cooper.exe'
$payload = Join-Path $repo 'dist/cooper.exe'
$output = Join-Path $repo 'dist/native-setup'
$savedBuildVersion = $env:COOPER_BUILD_VERSION
$savedLauncherVersion = $env:COOPER_LAUNCHER_BUILD_VERSION

Push-Location -LiteralPath $repo
try {
    $env:COOPER_LAUNCHER_BUILD_VERSION = $Version
    & $cargo build --manifest-path 'apps/cli/launcher/Cargo.toml' --locked --release
    if ($LASTEXITCODE -ne 0) { throw 'The Rust launcher build failed.' }
    $env:COOPER_BUILD_VERSION = $Version
    & $node scripts/package.mjs
    if ($LASTEXITCODE -ne 0) { throw 'The SEA build failed.' }

    $launcherVersion = & $launcher --launcher-version
    if ($LASTEXITCODE -ne 0 -or $launcherVersion -cne $Version) { throw 'Built launcher version does not match Setup.' }
    $payloadVersion = & $payload --version
    if ($LASTEXITCODE -ne 0 -or $payloadVersion -cne $Version) { throw 'Built SEA version does not match Setup.' }

    $pathScript = (Get-Content -LiteralPath 'scripts/native-cli-user-path.ps1' -Raw) + "`n" + @'
$ErrorActionPreference = 'Stop'
Set-CooperUserPath -Action $env:COOPER_SETUP_PATH_ACTION -Bin $env:COOPER_SETUP_BIN
'@
    $encodedPathScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($pathScript))
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    & $InnoCompiler "/DCooperVersion=$Version" "/DLauncherPath=$launcher" "/DPayloadPath=$payload" `
        "/DSetupOutputDir=$output" "/DPathScript=$encodedPathScript" 'scripts/windows/cooper-setup.iss'
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not create CooperSetup.' }
    Get-Item -LiteralPath (Join-Path $output "CooperSetup-$Version-windows-x64.exe")
} finally {
    $env:COOPER_BUILD_VERSION = $savedBuildVersion
    $env:COOPER_LAUNCHER_BUILD_VERSION = $savedLauncherVersion
    Pop-Location
}
