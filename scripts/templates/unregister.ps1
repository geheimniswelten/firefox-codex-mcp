param([string]$ProjectRoot, [switch]$NoRegisterClients, [switch]$Help)
$ErrorActionPreference = 'Stop'
# Companion version: __VERSION__; registration revision: __REVISION__.
__COMMON_PS__
if ($Help) {
    Write-Host 'unregister.ps1 [-ProjectRoot ABSOLUTE_DIRECTORY] [-NoRegisterClients]'
    Write-Host 'Removes only this companion registration. Application files and settings are kept.'
    exit 0
}
try {
    $root = Get-FirefoxSetupRoot -RequestedRoot $ProjectRoot
    $registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge'
    $key = Get-Item -LiteralPath $registryPath -ErrorAction SilentlyContinue
    $expected = Join-Path $root '.local\de.codex.firefox_bridge.json'
    if ($key) {
        if (@(Get-ChildItem -LiteralPath $registryPath).Count -gt 0) { throw 'The registration has unexpected child keys; nothing removed.' }
        $registered = [string]$key.GetValue('')
        if (-not [string]::Equals([IO.Path]::GetFullPath($registered), [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { throw 'The registered companion belongs to another directory; nothing removed.' }
        if ((Get-FirefoxInstalledRoot) -ne $root) { throw 'The manifest does not identify this companion; nothing removed.' }
        # Recheck immediately before removing this single key; never recurse.
        $latest = Get-Item -LiteralPath $registryPath
        if ($latest.GetValue('') -ne $registered -or @(Get-ChildItem -LiteralPath $registryPath).Count -gt 0) { throw 'The registration changed; nothing removed.' }
        Remove-Item -LiteralPath $registryPath -Force
    }
    $receipt = Join-Path $root '.local\registration-status.json'
    Assert-FirefoxOrdinaryPath -Path $receipt
    if ([IO.File]::Exists($receipt)) {
        $status = [IO.File]::ReadAllText($receipt) | ConvertFrom-Json
        if ($status.manifestPath -and [string]::Equals([IO.Path]::GetFullPath($status.manifestPath), [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $receipt -Force }
    }
    Write-Host 'Native Host deregistered. Companion files and settings are kept.'
    if (-not $NoRegisterClients) {
        $registrar = Join-Path $root 'scripts\configure-clients.mjs'
        try {
            $candidates = New-Object 'System.Collections.Generic.List[string]'
            $launcher = Join-Path $root '.local\native-host.cmd'
            if ([IO.File]::Exists($launcher)) {
                $text = [IO.File]::ReadAllText($launcher)
                if ($text -match '(?m)^"(?<Node>[^"]+)"[ \t]+"[^"]+"') { $candidates.Add($Matches.Node) }
            }
            foreach ($command in @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
            $nodePath = $null
            foreach ($candidate in $candidates) {
                if (-not [IO.File]::Exists($candidate)) { continue }
                $version = & $candidate --version 2>$null
                if ($LASTEXITCODE -eq 0 -and $version -match '^v(?<Major>[0-9]+)\.' -and [int]$Matches.Major -ge 22) { $nodePath = $candidate; break }
            }
            if (-not $nodePath -or -not [IO.File]::Exists($registrar)) { throw 'Node.js 22+ or the installed client registrar is missing.' }
            & $nodePath $registrar --root $root --remove
            if ($LASTEXITCODE -ne 0) { exit 2 }
        } catch {
            Write-Warning ('Native Host deregistered; AI client entries could not be checked: ' + $_.Exception.Message)
            exit 2
        }
    }
    Write-Host 'Return to the extension settings and choose Check again.'
} catch { Write-Host ('Deregistration failed: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
