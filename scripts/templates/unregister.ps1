param([string]$ProjectRoot, [switch]$NoRegisterClients, [switch]$Help)
$ErrorActionPreference = 'Stop'
# Companion version: __VERSION__; registration revision: __REVISION__.
__COMMON_PS__
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
