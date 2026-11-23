param([string]$Destination)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows/powershell-runtime.ps1')
if (-not $Destination) {
    $Destination = Join-Path $repo ('dist/windows-runtime-' + [guid]::NewGuid().ToString('N'))
}
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw "Runtime destination already exists: $Destination" }
$manifest = Join-Path $repo 'packages/shell-sandbox/Cargo.toml'
& cargo.exe build --locked --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'The Windows shell sandbox build failed.' }
Expand-CooperPowerShell -Destination (Join-Path $Destination 'powershell') -Cache (Join-Path $repo 'dist/tools')
Copy-Item -LiteralPath (Join-Path $repo 'packages/shell-sandbox/target/release/cooper-shell-sandbox.exe') -Destination $Destination
Get-Item -LiteralPath $Destination
