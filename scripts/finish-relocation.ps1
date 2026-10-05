# Reuse the uninstaller's exact argument and PID/creation-time ownership checks.
# Dot-sourcing either file exposes functions without uninstalling or stopping anything.
. (Join-Path $PSScriptRoot '..\uninstall.ps1')

function Get-FirefoxPreviousManifest {
    $key = Get-Item -LiteralPath 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge' -ErrorAction SilentlyContinue
    if (-not $key) { return $null }
    try {
        if ($key.SubKeyCount -gt 0 -or @($key.GetValueNames() | Where-Object { $_ -ne '' }).Count -gt 0) {
            throw 'Die Native-Host-Registrierung enthaelt unbekannte Zusatzwerte oder Unterschluessel; alte Prozesse bleiben erhalten.'
        }
        $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $manifest = if ($value -is [string] -and $value -notmatch '[\x00-\x1f\x7f]') { ConvertTo-FirefoxBridgePath $value } else { $null }
        if (-not $manifest -or [IO.Path]::GetFileName($manifest) -ine 'de.codex.firefox_bridge.json' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($manifest)) -ine '.local') {
            throw 'Die Native-Host-Registrierung enthaelt keinen eindeutigen eigenen Manifestpfad; alte Prozesse bleiben erhalten.'
        }
        return $manifest
    } finally { $key.Close() }
}

function Stop-FirefoxPreviousInstallation {
    param([AllowNull()][string]$PreviousManifest, [Parameter(Mandatory = $true)][string]$CurrentRoot)
    if (-not $PreviousManifest) { return }
    $manifest = ConvertTo-FirefoxBridgePath $PreviousManifest
    $current = ConvertTo-FirefoxBridgePath $CurrentRoot
    if (-not $manifest -or -not $current -or [IO.Path]::GetFileName($manifest) -ine 'de.codex.firefox_bridge.json' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($manifest)) -ine '.local') {
        throw 'Die vorherige Installation ist nicht eindeutig zuordenbar. Firefox und die KI-Apps neu starten.'
    }
    $previousRoot = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($manifest))
    if (Test-FirefoxBridgePathEqual $previousRoot $current) { return }
    $expected = [IO.Path]::Combine($current, '.local\de.codex.firefox_bridge.json')
    if (-not (Test-FirefoxBridgePathEqual (Get-FirefoxPreviousManifest) $expected)) {
        throw 'Die neue Native-Host-Registrierung ist nicht bestaetigt. Alte Prozesse bleiben erhalten; Firefox und die KI-Apps neu starten.'
    }
    $paths = Get-FirefoxBridgeLocalFiles -ProjectPath $previousRoot
    $owned = @()
    foreach ($snapshot in @(Get-FirefoxBridgeProcesses)) {
        if (Test-FirefoxBridgeProcessOwnership $snapshot $paths) { $owned += $snapshot; continue }
        if (-not $snapshot.CommandLine) {
            Write-Warning 'Ein Node-Prozess ist nicht lesbar und bleibt erhalten. Firefox und die KI-Apps neu starten.'
            continue
        }
        foreach ($argument in @(Get-FirefoxBridgeProcessArguments $snapshot.CommandLine)) {
            if ((Test-FirefoxBridgePathEqual $argument ([IO.Path]::Combine($previousRoot, 'server\native-host.mjs'))) -or (Test-FirefoxBridgePathEqual $argument ([IO.Path]::Combine($previousRoot, 'server\mcp.mjs')))) {
                throw 'Ein moeglicher alter Bridge-Prozess ist nicht eindeutig zuordenbar. Es wird kein Prozess beendet; Firefox und die KI-Apps neu starten.'
            }
        }
    }
    foreach ($snapshot in $owned) {
        if (-not (Test-FirefoxBridgePathEqual (Get-FirefoxPreviousManifest) $expected)) {
            throw 'Die Native-Host-Registrierung wurde inzwischen geaendert. Weitere alte Prozesse bleiben erhalten; Firefox und die KI-Apps neu starten.'
        }
        Stop-FirefoxBridgeProcess $snapshot
    }
    if ($owned.Count -gt 0) { Write-Host ("Vorherige Bridge-Prozesse beendet: " + $owned.Count + '.') }
    Write-Host 'Nach dem Ordnerwechsel Firefox vollstaendig beenden und neu starten; anschliessend MCP-Verbindungen in den KI-Apps neu laden.'
}
