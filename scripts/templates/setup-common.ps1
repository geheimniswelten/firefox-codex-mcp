# Shared source for the standalone Windows downloads. ASCII for PowerShell 5.1.
function Get-FirefoxInstalledRoot {
    $key = Get-Item -LiteralPath 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge' -ErrorAction SilentlyContinue
    if (-not $key) { return $null }
    try {
        $manifestPath = [string]$key.GetValue('')
        $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
        if ($manifest.name -ne 'de.codex.firefox_bridge' -or $manifest.type -ne 'stdio' -or @($manifest.allowed_extensions).Count -ne 1 -or $manifest.allowed_extensions[0] -ne 'firefox-codex-mcp@local.invalid') { return $null }
        $local = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($manifest.path))
        if ([IO.Path]::GetFileName($local) -ne '.local' -or [IO.Path]::GetFileName($manifest.path) -ne 'native-host.cmd') { return $null }
        return [IO.Path]::GetDirectoryName($local)
    } catch { return $null }
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
