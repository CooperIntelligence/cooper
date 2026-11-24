param(
    [string]$Version,
    [string]$Experiment,
    [string]$InnoCompiler
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows/setup-build-identity.ps1')
if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $repo 'apps/cli/package.json') -Raw | ConvertFrom-Json).version
}

function Get-CooperSourceSnapshot {
    $commit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not identify the source commit.' }
    $status = & git status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the source worktree.' }
    $files = & git -c core.quotePath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate the source files.' }
    $entries = foreach ($file in ($files | Sort-Object -CaseSensitive -Unique)) {
        $localFile = Join-Path $repo $file
        $hash = if (Test-Path -LiteralPath $localFile -PathType Leaf) {
            (Get-FileHash -LiteralPath $localFile -Algorithm SHA256).Hash
        } else { 'missing' }
        "${file}:$hash"
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $snapshot = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
        $digest = [BitConverter]::ToString($sha.ComputeHash($snapshot)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
    return [ordered]@{ commit = $commit; dirty = [bool]$status; treeSha256 = $digest }
}

$buildLock = Open-CooperSetupBuildLock -Repo $repo -Product 'internal-windows'
Push-Location -LiteralPath $repo
try {
    $internalRoot = Join-Path $repo 'dist/internal'
    New-Item -ItemType Directory -Path $internalRoot -Force | Out-Null
    $day = [DateTime]::Now.ToString('yyyyMMdd', [Globalization.CultureInfo]::InvariantCulture)
    $sequenceFile = Join-Path $internalRoot "$day.sequence"
    $sequence = if (Test-Path -LiteralPath $sequenceFile) {
        [int](Get-Content -LiteralPath $sequenceFile -Raw)
    } else { 0 }
    foreach ($directory in Get-ChildItem -LiteralPath $internalRoot -Directory -Filter "$day.*") {
        if ($directory.Name -match '^\d{8}\.([1-9]\d*)$') { $sequence = [Math]::Max($sequence, [int]$Matches[1]) }
    }
    $sequence++
    $build = "$day.$sequence"
    $output = Join-Path $internalRoot $build
    $identity = Get-CooperSetupIdentity -Version $Version -InternalBuild $build
    $source = Get-CooperSourceSnapshot
    New-Item -ItemType Directory -Path $output | Out-Null
    Set-Content -LiteralPath $sequenceFile -Value $sequence -Encoding ascii

    $setup = @{ Version = $Version; InternalBuild = $build; OutputDirectory = $output; InnoCompiler = $InnoCompiler }
    & (Join-Path $PSScriptRoot 'build-native-setup.ps1') @setup | Out-Host
    & (Join-Path $PSScriptRoot 'build-desktop-setup.ps1') @setup | Out-Host

    $after = Get-CooperSourceSnapshot
    if ($source.commit -ne $after.commit -or $source.treeSha256 -ne $after.treeSha256) {
        throw 'The source changed during the build. This batch has no complete build manifest.'
    }
    $artifacts = foreach ($product in @('CooperSetup', 'CooperDesktopSetup')) {
        $file = Get-Item -LiteralPath (Join-Path $output "$product-$($identity.Version)-windows-x64.exe")
        [ordered]@{ file = $file.Name; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    }
    $manifest = [ordered]@{
        channel = 'internal'
        productVersion = $Version
        buildNumber = $build
        version = $identity.Version
        experiment = $Experiment
        builtAt = [DateTimeOffset]::Now.ToString('o')
        source = $source
        artifacts = @($artifacts)
    }
    $manifestFile = Join-Path $output 'build.json'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestFile -Encoding utf8
    Get-Item -LiteralPath $manifestFile
} finally {
    Pop-Location
    $buildLock.Dispose()
}
