function Set-CooperUserPath([ValidateSet('add', 'remove')][string]$Action, [string]$Bin) {
    if ($Bin.StartsWith('\\?\')) { $Bin = $Bin.Substring(4) }
    $environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $hasPath = $environment.GetValueNames() -contains 'Path'
        $kind = if ($hasPath) { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        if ($kind -notin [Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString) {
            throw 'The user PATH must be a registry string.'
        }
        $current = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $remaining = @()
        if ($current.Length -gt 0) {
            $remaining = @($current.Split(';') | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ne $Bin.TrimEnd('\') })
        }
        $next = if ($Action -eq 'add') { (@($Bin) + $remaining) -join ';' } else { $remaining -join ';' }
        if ($next -cne $current) {
            if ($next.Length -eq 0) { $environment.DeleteValue('Path', $false) }
            else { $environment.SetValue('Path', $next, $kind) }
        }
    } finally {
        $environment.Dispose()
    }
}
