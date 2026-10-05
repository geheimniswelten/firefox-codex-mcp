# Shared source for the standalone Windows downloads. ASCII for PowerShell 5.1.
function Get-FirefoxInstalledRoot {
    try {
        $registration = Get-FirefoxNativeRegistration
        if ($registration) { return $registration.Root }
        return $null
    } catch { return $null }
}
function Get-FirefoxNativeRegistration {
    $registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge'
    $key = Get-Item -LiteralPath $registryPath -ErrorAction SilentlyContinue
    if (-not $key) { return $null }
    if (@(Get-ChildItem -LiteralPath $registryPath).Count -gt 0 -or @($key.GetValueNames()).Count -ne 1 -or @($key.GetValueNames())[0] -ne '' -or $key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'The registration has unexpected values or child keys; nothing removed.' }
    $registeredValue = [string]$key.GetValue('')
    $manifestPath = $registeredValue
    if ($manifestPath -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { throw 'The registered manifest path is not fully qualified; nothing removed.' }
    $manifestPath = [IO.Path]::GetFullPath($manifestPath)
    $local = [IO.Path]::GetDirectoryName($manifestPath)
    if ([IO.Path]::GetFileName($local) -ne '.local' -or [IO.Path]::GetFileName($manifestPath) -ne 'de.codex.firefox_bridge.json') { throw 'The registered path does not identify this companion; nothing removed.' }
    $root = [IO.Path]::GetDirectoryName($local)
    if ($root.TrimEnd([char[]]'\/') -eq [IO.Path]::GetPathRoot($root).TrimEnd([char[]]'\/')) { throw 'The registered companion root is unsafe; nothing removed.' }
    Assert-FirefoxOrdinaryPath -Path $manifestPath
    $manifestText = $null
    if ([IO.File]::Exists($manifestPath)) {
        $manifestText = [IO.File]::ReadAllText($manifestPath)
        $manifest = $manifestText | ConvertFrom-Json
        $expectedLauncher = [IO.Path]::Combine($root, '.local\native-host.cmd')
        if ($manifest.name -ne 'de.codex.firefox_bridge' -or $manifest.type -ne 'stdio' -or @($manifest.allowed_extensions).Count -ne 1 -or $manifest.allowed_extensions[0] -ne 'firefox-codex-mcp@local.invalid' -or -not $manifest.path -or $manifest.path -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or -not [string]::Equals([IO.Path]::GetFullPath($manifest.path), $expectedLauncher, [StringComparison]::OrdinalIgnoreCase)) { throw 'The manifest does not identify this companion; nothing removed.' }
    }
    return [pscustomobject]@{ Root = $root; ManifestPath = $manifestPath; RegisteredValue = $registeredValue; ManifestText = $manifestText }
}
function Get-FirefoxSetupRoot {
    param([string]$RequestedRoot)
    if ($RequestedRoot) {
        $selected = $RequestedRoot
    } else {
        $default = Get-FirefoxInstalledRoot
        if (-not $default) {
            if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable. Supply -ProjectRoot.' }
            $default = Join-Path $env:LOCALAPPDATA 'FirefoxCodexMCP'
        }
        Write-Host 'Codex MCP for Firefox - local companion'
        Write-Host ('Installation directory: ' + $default)
        Write-Host 'Registration updates the companion files in the selected directory.'
        $selected = Read-Host 'Directory (Enter accepts the displayed directory)'
        if (-not $selected) { $selected = $default }
    }
    if ($selected -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { throw '-ProjectRoot needs a fully qualified absolute installation directory.' }
    $full = [IO.Path]::GetFullPath($selected).TrimEnd([char[]]'\/')
    if ($full.TrimEnd([char[]]'\/') -eq [IO.Path]::GetPathRoot($full).TrimEnd([char[]]'\/')) { throw 'Do not select a drive root.' }
    Assert-FirefoxOrdinaryPath -Path $full -Directory
    return $full
}
function Assert-FirefoxOrdinaryPath {
    param([string]$Path, [switch]$Directory)
    $current = [IO.Path]::GetFullPath($Path)
    $first = $true
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (($Directory -or -not $first) -and -not $item.PSIsContainer) -or ($first -and -not $Directory -and $item.PSIsContainer)) { throw ('Unsafe installation path: ' + $current) }
        }
        $first = $false
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
