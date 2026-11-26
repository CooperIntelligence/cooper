param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Cooper'),
    [switch]$SkipPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-cli-user-path.ps1')

function Add-CooperToUserPath([string]$Bin) {
    Set-CooperUserPath -Action add -Bin $Bin

    if (-not ('Cooper.Native.EnvironmentChange' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Cooper.Native {
    public static class EnvironmentChange {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, UIntPtr wParam, string lParam,
            uint flags, uint timeout, out UIntPtr result);

        public static void Broadcast() {
            UIntPtr result;
            SendMessageTimeout(new IntPtr(0xffff), 0x001a, UIntPtr.Zero, "Environment", 0x0002, 1000, out result);
        }
    }
}
'@
    }
    [Cooper.Native.EnvironmentChange]::Broadcast()

    $processEntries = @($env:Path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $Bin })
    $env:Path = (@($Bin) + $processEntries) -join ';'
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') {
    throw 'This Cooper build targets Windows x64.'
}

$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'apps/cli/launcher/target/release/cooper.exe'
$payload = Join-Path $repo 'dist/cooper.exe'
foreach ($file in @($launcher, $payload)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prebuilt binary: $file" }
}

$version = (Get-Content -LiteralPath (Join-Path $repo 'apps/cli/package.json') -Raw | ConvertFrom-Json).version
if ($version -cnotmatch '^\d+\.\d+\.\d+(?:-(alpha|rc)\.\d+)?$') { throw "Invalid release version: $version" }
$channel = if ($version.Contains('-alpha.')) { 'alpha' } else { 'latest' }

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$parent = Split-Path -Parent $InstallRoot
if (-not $parent -or $InstallRoot.Contains(';')) { throw 'Choose a user directory that can be added to PATH.' }
$bin = Join-Path $InstallRoot 'bin'
$installedLauncher = Join-Path $bin 'cooper.exe'
$installedPayload = Join-Path $InstallRoot "versions/$version/cooper.exe"

if (Test-Path -LiteralPath $InstallRoot) {
    $state = Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw | ConvertFrom-Json
    if ($state.active -ne $version -or
        -not (Test-Path -LiteralPath $installedLauncher -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installedPayload -PathType Leaf) -or
        (Get-FileHash -LiteralPath $installedLauncher).Hash -ne (Get-FileHash -LiteralPath $launcher).Hash -or
        (Get-FileHash -LiteralPath $installedPayload).Hash -ne (Get-FileHash -LiteralPath $payload).Hash) {
        throw "Another Cooper installation already exists at $InstallRoot."
    }
} else {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $resolvedParent = (Resolve-Path -LiteralPath $parent).Path
    $stage = Join-Path $resolvedParent ('.cooper-install-' + [guid]::NewGuid().ToString('N'))
    $stageBin = Join-Path $stage 'bin'
    $stageVersion = Join-Path $stage "versions/$version"
    try {
        New-Item -ItemType Directory -Path $stageBin,$stageVersion -Force | Out-Null
        Copy-Item -LiteralPath $launcher -Destination (Join-Path $stageBin 'cooper.exe')
        Copy-Item -LiteralPath $payload -Destination (Join-Path $stageVersion 'cooper.exe')
        $stateJson = @{ active = $version; previous = $null; channel = $channel } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $stage 'current.json'), $stateJson, [Text.UTF8Encoding]::new($false))

        & (Join-Path $stageBin 'cooper.exe') --help | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'The staged Cooper executable did not start.' }
        if ((Resolve-Path -LiteralPath $stage).Path -ne $stage -or (Join-Path $resolvedParent (Split-Path -Leaf $InstallRoot)) -ne $InstallRoot) {
            throw 'Unexpected installation directory.'
        }
        [IO.Directory]::Move($stage, $InstallRoot)
    } finally {
        if ((Test-Path -LiteralPath $stage) -and (Resolve-Path -LiteralPath $stage).Path -eq $stage -and
            (Split-Path -Parent $stage) -eq $resolvedParent -and (Split-Path -Leaf $stage).StartsWith('.cooper-install-')) {
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
    }
}

if (-not $SkipPath) { Add-CooperToUserPath $bin }
Write-Output "Installed Cooper CLI $version at $installedLauncher"
