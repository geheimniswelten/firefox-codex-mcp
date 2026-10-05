param([string]$ProjectRoot, [switch]$NoRegisterClients, [switch]$Help)
$ErrorActionPreference = 'Stop'
# Companion version: 1.0.6; registration revision: 1.
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

if ($Help) {
    Write-Host 'unregister.ps1 [-ProjectRoot ABSOLUTE_DIRECTORY] [-NoRegisterClients]'
    Write-Host 'Discovers and removes this companion registration, including missing old installation directories.'
    Write-Host 'Application files and settings are kept. Native-only removal needs no Node.js.'
    exit 0
}
try {
    $registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge'
    $registration = Get-FirefoxNativeRegistration
    # The registry identifies the installed companion, independently of the
    # current directory and any explicitly selected new installation directory.
    if ($registration) {
        $root = $registration.Root
        $expected = $registration.ManifestPath
        $latest = Get-FirefoxNativeRegistration
        if (-not $latest -or $latest.RegisteredValue -cne $registration.RegisteredValue -or $latest.ManifestText -cne $registration.ManifestText) { throw 'The registration changed; nothing removed.' }
        Remove-Item -LiteralPath $registryPath -Force
    } else {
        if ($ProjectRoot) { $root = Get-FirefoxSetupRoot -RequestedRoot $ProjectRoot }
        elseif ([IO.File]::Exists((Join-Path $PSScriptRoot 'scripts\configure-clients.mjs'))) { $root = Get-FirefoxSetupRoot -RequestedRoot $PSScriptRoot }
        elseif ([IO.Path]::GetFileName($PSScriptRoot) -eq 'scripts' -and [IO.File]::Exists((Join-Path $PSScriptRoot 'configure-clients.mjs'))) { $root = Get-FirefoxSetupRoot -RequestedRoot ([IO.Path]::GetDirectoryName($PSScriptRoot)) }
        elseif ($env:LOCALAPPDATA) { $root = Get-FirefoxSetupRoot -RequestedRoot (Join-Path $env:LOCALAPPDATA 'FirefoxCodexMCP') }
        else { $root = $null }
        $expected = if ($root) { [IO.Path]::Combine($root, '.local\de.codex.firefox_bridge.json') } else { $null }
    }
    $partial = $false
    if ($root) {
        try {
            $receipt = [IO.Path]::Combine($root, '.local\registration-status.json')
            Assert-FirefoxOrdinaryPath -Path $receipt
            if ([IO.File]::Exists($receipt)) {
                $original = [IO.File]::ReadAllText($receipt)
                $status = $original | ConvertFrom-Json
                $receiptRegistryPath = 'HKCU\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge'
                $parsedTime = [datetime]::MinValue
                $validTime = $status.registeredAt -is [string] -and [datetime]::TryParseExact($status.registeredAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsedTime)
                if ($status.schemaVersion -is [int] -and $status.schemaVersion -eq 1 -and $status.platform -is [string] -and $status.platform -ceq 'win' -and $status.registrationRevision -is [int] -and $status.registrationRevision -ge 1 -and $status.installerVersion -is [string] -and $status.installerVersion -match '^\d+\.\d+\.\d+$' -and $validTime -and $status.manifestPath -is [string] -and $status.manifestPath -match '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -and [string]::Equals([IO.Path]::GetFullPath($status.manifestPath), $expected, [StringComparison]::OrdinalIgnoreCase) -and (-not ($status.PSObject.Properties.Name -contains 'registrationPath') -or ($status.registrationPath -is [string] -and $status.registrationPath -ceq $receiptRegistryPath))) {
                    Assert-FirefoxOrdinaryPath -Path $receipt
                    if ([IO.File]::ReadAllText($receipt) -cne $original) { throw 'The registration receipt changed; it was kept.' }
                    Remove-Item -LiteralPath $receipt -Force
                }
            }
        } catch { Write-Warning ('Native Host deregistered; registration receipt was kept: ' + $_.Exception.Message); $partial = $true }
    }
    Write-Host 'Native Host deregistered. Companion files and settings are kept.'
    if (-not $NoRegisterClients) {
        try {
            $registrar = $null
            $roots = New-Object 'System.Collections.Generic.List[string]'
            $roots.Add($PSScriptRoot)
            if ([IO.Path]::GetFileName($PSScriptRoot) -eq 'scripts') { $roots.Add([IO.Path]::GetDirectoryName($PSScriptRoot)) }
            if ($root) { $roots.Add($root) }
            if ($ProjectRoot) { $roots.Add((Get-FirefoxSetupRoot -RequestedRoot $ProjectRoot)) }
            foreach ($candidateRoot in $roots) {
                $candidate = [IO.Path]::Combine($candidateRoot, 'scripts\configure-clients.mjs')
                Assert-FirefoxOrdinaryPath -Path $candidate
                if ([IO.File]::Exists($candidate)) { $registrar = $candidate; break }
            }
            $candidates = New-Object 'System.Collections.Generic.List[string]'
            foreach ($candidateRoot in $roots) {
                $candidates.Add([IO.Path]::Combine($candidateRoot, '.runtime\node\node.exe'))
                $launcher = [IO.Path]::Combine($candidateRoot, '.local\native-host.cmd')
                Assert-FirefoxOrdinaryPath -Path $launcher
                if ([IO.File]::Exists($launcher)) {
                    $text = [IO.File]::ReadAllText($launcher)
                    if ($text -match '(?m)^"(?<Node>[^"]+)"[ \t]+"[^"]+"') { $candidates.Add($Matches.Node) }
                }
            }
            foreach ($command in @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
            $nodePath = $null
            foreach ($candidate in $candidates) {
                Assert-FirefoxOrdinaryPath -Path $candidate
                if (-not [IO.File]::Exists($candidate)) { continue }
                $version = & $candidate --version 2>$null
                if ($LASTEXITCODE -eq 0 -and $version -match '^v(?<Major>[0-9]+)\.' -and [int]$Matches.Major -ge 22) { $nodePath = $candidate; break }
            }
            if (-not $root -or -not $nodePath -or -not $registrar) { throw 'Node.js 22+ or a current client registrar is missing.' }
            & $nodePath $registrar --root $root --remove --discover
            if ($LASTEXITCODE -ne 0) { $partial = $true }
        } catch {
            Write-Warning ('Native Host deregistered; AI client entries could not be checked: ' + $_.Exception.Message)
            $partial = $true
        }
    }
    Write-Host 'Return to the extension settings and choose Check again.'
    if ($partial) { exit 2 }
} catch { Write-Host ('Deregistration failed: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
