function Expand-CooperPowerShell([string]$Destination, [string]$Cache) {
    $version = '7.7.0'
    $expectedHash = '7C74E03B20A75B59715847439D046A6214B1863EE79B187872980F139BB4A05F'
    $asset = "PowerShell-$version-win-x64.zip"
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $archive = Join-Path $cache $asset
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        $download = Join-Path $cache ([guid]::NewGuid().ToString('N') + '.download')
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/PowerShell/PowerShell/releases/download/v$version/$asset" -OutFile $download
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $expectedHash) {
                throw 'The downloaded PowerShell runtime failed SHA256 verification.'
            }
            Move-Item -LiteralPath $download -Destination $archive
        } finally {
            if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
        }
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $expectedHash) {
        throw "The cached PowerShell runtime failed SHA256 verification. Replace $archive with the official release archive."
    }
    if (Test-Path -LiteralPath $Destination) { throw "PowerShell destination already exists: $Destination" }
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination
}
