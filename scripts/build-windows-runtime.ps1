param([string]$Destination)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows/powershell-runtime.ps1')
if (-not $Destination) {
    $Destination = Join-Path $repo ('dist/windows-runtime-' + [guid]::NewGuid().ToString('N'))
}
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw "Runtime destination already exists: $Destination" }
Expand-CooperPowerShell -Destination (Join-Path $Destination 'powershell') -Cache (Join-Path $repo 'dist/tools')
Get-Item -LiteralPath $Destination
