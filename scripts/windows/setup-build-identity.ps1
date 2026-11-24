function Get-CooperSetupIdentity([string]$Version, [string]$InternalBuild) {
    $release = '(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?'
    if ($InternalBuild) {
        if ($Version -cnotmatch "^$release`$") { throw "Invalid product version for an internal build: $Version" }
        if ($InternalBuild -cnotmatch '^\d{8}\.[1-9]\d*$') { throw "Invalid internal build number: $InternalBuild" }
        return @{ Version = "$Version+internal.$InternalBuild"; Channel = 'internal'; InnoInternal = 1 }
    }
    if ($Version -cnotmatch "^$release(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`$" -or
        $Version -match '\+internal(?:\.|$)') {
        throw "Invalid public setup version: $Version. Use the paired internal build command for internal packages."
    }
    return @{ Version = $Version; Channel = 'public'; InnoInternal = 0 }
}

function Open-CooperSetupBuildLock([string]$Repo, [string]$Product) {
    $dist = Join-Path $Repo 'dist'
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    return [IO.File]::Open((Join-Path $dist "$Product-build.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
}
