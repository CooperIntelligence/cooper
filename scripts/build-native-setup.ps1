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
$output = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repo 'dist/native-setup' }
$outputFile = Join-Path $output "CooperSetup-$Version-windows-x64.exe"
$runtimeStage = Join-Path $repo ('dist/powershell-stage-' + [guid]::NewGuid().ToString('N'))
$savedBuildVersion = $env:COOPER_BUILD_VERSION
$savedLauncherVersion = $env:COOPER_LAUNCHER_BUILD_VERSION
$savedLauncherChannel = $env:COOPER_LAUNCHER_BUILD_CHANNEL
$savedBuildChannel = $env:COOPER_BUILD_CHANNEL

$buildLock = Open-CooperSetupBuildLock -Repo $repo -Product 'native-setup'
Push-Location -LiteralPath $repo
try {
    if ($InternalBuild -and (Test-Path -LiteralPath $outputFile)) { throw "Build already exists: $outputFile" }
    $env:COOPER_LAUNCHER_BUILD_VERSION = $Version
    $env:COOPER_LAUNCHER_BUILD_CHANNEL = $identity.Channel
    & $cargo build --manifest-path 'apps/cli/launcher/Cargo.toml' --locked --release
    if ($LASTEXITCODE -ne 0) { throw 'The Rust launcher build failed.' }
    $env:COOPER_BUILD_VERSION = $Version
    $env:COOPER_BUILD_CHANNEL = $identity.Channel
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
    Expand-CooperPowerShell -Destination $runtimeStage -Cache (Join-Path $repo 'dist/tools')
    & $InnoCompiler /Qp "/DCooperVersion=$Version" "/DCooperInternal=$($identity.InnoInternal)" "/DLauncherPath=$launcher" "/DPayloadPath=$payload" `
        "/DPowerShellDir=$runtimeStage" "/DSetupOutputDir=$output" "/DPathScript=$encodedPathScript" 'scripts/windows/cooper-setup.iss' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not create CooperSetup.' }
    Get-Item -LiteralPath $outputFile
} finally {
    $env:COOPER_BUILD_VERSION = $savedBuildVersion
    $env:COOPER_LAUNCHER_BUILD_VERSION = $savedLauncherVersion
    $env:COOPER_LAUNCHER_BUILD_CHANNEL = $savedLauncherChannel
    $env:COOPER_BUILD_CHANNEL = $savedBuildChannel
    Pop-Location
    $buildLock.Dispose()
    if (Test-Path -LiteralPath $runtimeStage) {
        $resolvedStage = (Resolve-Path -LiteralPath $runtimeStage).Path
        if ((Split-Path -Parent $resolvedStage) -eq (Resolve-Path -LiteralPath (Join-Path $repo 'dist')).Path -and
            (Split-Path -Leaf $resolvedStage) -like 'powershell-stage-*') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
