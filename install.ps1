param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 38477,
    [switch]$GenerateOnly,
    [switch]$NoDownload,
    [switch]$NoOpenFirefox,
    [switch]$NoRegisterClients,
    [switch]$ReservePort,
    [switch]$NoPortReservationPrompt,
    [switch]$OpenFirefoxOnly,
    [string]$ReplaceNativeManifest
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
if ($PSBoundParameters.ContainsKey('ReplaceNativeManifest')) {
    if ($GenerateOnly -or $OpenFirefoxOnly) {
        Write-Host '-ReplaceNativeManifest kann nicht mit -GenerateOnly oder -OpenFirefoxOnly kombiniert werden.' -ForegroundColor Red
        exit 1
    }
    if ($ReplaceNativeManifest -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or $ReplaceNativeManifest -match '[\x00-\x1f\x7f]') {
        Write-Host '-ReplaceNativeManifest erwartet den absoluten bisherigen Manifestpfad aus der Fehlermeldung.' -ForegroundColor Red
        exit 1
    }
}
if ($OpenFirefoxOnly) {
    try {
        . (Join-Path $projectRoot 'scripts\open-firefox-setup.ps1')
        if (-not (Open-FirefoxSetupPage -ProjectRoot $projectRoot)) { exit 1 }
        exit 0
    } catch {
        Write-Host ('Firefox konnte nicht geoeffnet werden: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host 'Bitte in Firefox manuell oeffnen: about:debugging#/runtime/this-firefox'
        Write-Host ('Dort unter "Temporaeres Add-on laden" auswaehlen: ' + [IO.Path]::Combine($projectRoot, 'extension\manifest.json'))
        exit 1
    }
}
$originalProcessPath = $env:PATH
$locationPushed = $false
$clientRegistrationFailed = $false
$relocationFailed = $false
try {
    . (Join-Path $projectRoot 'scripts\node-runtime.ps1')
    $runtime = Resolve-FirefoxNodeRuntime -ProjectRoot $projectRoot -NoDownload:$NoDownload
    # Dependency scripts can find this Node without changing Windows settings.
    $env:PATH = [IO.Path]::GetDirectoryName($runtime.NodePath) + ';' + $originalProcessPath
    Write-Host ("Node.js: " + $runtime.NodePath)
    Push-Location -LiteralPath $projectRoot
    $locationPushed = $true
    if ($runtime.NpmCliPath) {
        & $runtime.NodePath $runtime.NpmCliPath ci --omit=dev
    } else {
        & $runtime.NpmCommandPath ci --omit=dev
    }
    if ($LASTEXITCODE -ne 0) { throw 'npm ci ist fehlgeschlagen.' }
    $previousNativeManifest = $null
    $relocationHelper = Join-Path $projectRoot 'scripts\finish-relocation.ps1'
    if (-not $GenerateOnly -and (Test-Path -LiteralPath $relocationHelper -PathType Leaf)) {
        . $relocationHelper
        $previousNativeManifest = Get-FirefoxPreviousManifest
    }
    $setupArgs = @((Join-Path $projectRoot 'scripts\setup.mjs'))
    $portArgs = @((Join-Path $projectRoot 'scripts\ports.mjs'), 'status', '--root', $projectRoot, '--json')
    if ($PSBoundParameters.ContainsKey('Port')) { $portArgs += @('--port', "$Port") }
    $portStatusText = & $runtime.NodePath @portArgs
    if ($LASTEXITCODE -ne 0) { throw 'Gemeinsame Portverwaltung konnte nicht geprueft werden; Konfiguration bleibt unveraendert.' }
    $portStatus = ($portStatusText -join "`n") | ConvertFrom-Json
    if (-not $GenerateOnly -and -not $ReservePort -and -not $NoPortReservationPrompt -and $portStatus.windowsServer -and @($portStatus.ownPorts) -notcontains $portStatus.port) {
        Write-Host ('Windows Server: Port ' + $portStatus.port + ' ist noch nicht fuer diesen Benutzer/Firefox MCP vorgemerkt.')
        Write-Host 'Die gemeinsame Portverwaltung stimmt Ports mit DAI und anderen Windows-Benutzern ab.'
        if ([Console]::IsInputRedirected) { throw 'Nicht-interaktiv auf Windows Server: -ReservePort oder -NoPortReservationPrompt ausdruecklich angeben.' }
        $portChoice = Read-Host 'Diesen Port dauerhaft vormerken? [J]a / [N]ein / [A]bbrechen'
        if ($portChoice -match '^(?i:j|ja|y|yes)$') { $ReservePort = $true }
        elseif ($portChoice -notmatch '^(?i:n|nein|no)$') { throw 'Einrichtung abgebrochen; keine Portkonfiguration geaendert.' }
    }
    if ($ReservePort) { $setupArgs += '--reserve-port' }
    elseif (-not $GenerateOnly -and -not $portStatus.windowsServer) {
        Write-Host 'Optionale gemeinsame Windows-Portverwaltung: install.ps1 -ReservePort (Details: PORT_RESERVATION.md).'
    }
    if ($PSBoundParameters.ContainsKey('Port')) { $setupArgs += @('--port', "$Port") }
    if (-not $GenerateOnly) { $setupArgs += '--register-native' }
    if ($PSBoundParameters.ContainsKey('ReplaceNativeManifest')) { $setupArgs += @('--replace-native-manifest', $ReplaceNativeManifest) }
    & $runtime.NodePath @setupArgs
    if ($LASTEXITCODE -ne 0) { throw 'Native-Host-Einrichtung ist fehlgeschlagen.' }
    if (-not $GenerateOnly -and -not $NoRegisterClients) {
        & $runtime.NodePath (Join-Path $projectRoot 'scripts\configure-clients.mjs') --root $projectRoot --relocate
        if ($LASTEXITCODE -ne 0) {
            $clientRegistrationFailed = $true
            Write-Warning 'Native Host eingerichtet; mindestens eine KI-Client-Konfiguration konnte nicht eingerichtet werden. Details stehen oben.'
        }
    } else {
        Write-Host 'KI-Client-Konfigurationen bleiben unveraendert. Manuelle Einrichtung: README.md und .local\codex-config.toml.'
    }
    if ($previousNativeManifest) {
        try { Stop-FirefoxPreviousInstallation -PreviousManifest $previousNativeManifest -CurrentRoot $projectRoot }
        catch {
            $relocationFailed = $true
            Write-Warning ('Die bisherige Bridge konnte nicht sicher beendet werden: ' + $_.Exception.Message + ' Firefox und betroffene KI-Apps neu starten.')
        }
    }
    Write-Host 'Danach Firefox-Erweiterung laden und die MCP-Verbindung der KI-Apps neu laden. Siehe README.md.'
    if (-not $GenerateOnly -and -not $NoOpenFirefox) {
        # Opening a convenience page must not turn a completed setup into a failure.
        try {
            . (Join-Path $projectRoot 'scripts\open-firefox-setup.ps1')
            $null = Open-FirefoxSetupPage -ProjectRoot $projectRoot
        } catch {
            Write-Warning ('Firefox konnte nicht automatisch geoeffnet werden: ' + $_.Exception.Message)
            Write-Host 'Bitte in Firefox manuell oeffnen: about:debugging#/runtime/this-firefox'
            Write-Host ('Dort unter "Temporaeres Add-on laden" auswaehlen: ' + [IO.Path]::Combine($projectRoot, 'extension\manifest.json'))
        }
    }
} catch {
    Write-Host ''
    Write-Host ("Installation fehlgeschlagen: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locationPushed) { Pop-Location }
    $env:PATH = $originalProcessPath
}
if ($clientRegistrationFailed -or $relocationFailed) { exit 2 }
