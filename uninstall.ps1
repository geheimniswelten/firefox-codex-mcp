[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'

function ConvertTo-FirefoxBridgePath {
    param([AllowNull()][string]$Value)
    if (-not $Value -or $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { return $null }
    try { return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]'\/') }
    catch { return $null }
}

function Test-FirefoxBridgePathEqual {
    param([AllowNull()][string]$First, [AllowNull()][string]$Second)
    $a = ConvertTo-FirefoxBridgePath $First
    $b = ConvertTo-FirefoxBridgePath $Second
    return $null -ne $a -and $null -ne $b -and [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
}

function Get-FirefoxBridgeLocalFiles {
    param([string]$ProjectPath = $PSScriptRoot)
    # The registered installation may differ from this freshly downloaded copy.
    $projectPath = ConvertTo-FirefoxBridgePath $ProjectPath
    if (-not $projectPath) { throw 'Der Projektpfad ist nicht eindeutig absolut.' }
    $localPath = ConvertTo-FirefoxBridgePath ([IO.Path]::Combine($projectPath, '.local'))
    if (-not (Test-FirefoxBridgePathEqual ([IO.Path]::GetDirectoryName($localPath)) $projectPath)) {
        throw 'Der .local-Pfad liegt nicht unmittelbar im Projekt.'
    }
    $localItem = Get-Item -LiteralPath $localPath -Force -ErrorAction SilentlyContinue
    if ($localItem -and (-not $localItem.PSIsContainer -or ($localItem.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw '.local ist kein regulaerer Ordner oder eine Verknuepfung. Aus Sicherheitsgruenden bleibt alles erhalten.'
    }
    $paths = @()
    foreach ($name in @('config.json', 'codex-config.toml', 'native-host.cmd', 'de.codex.firefox_bridge.json')) {
        $path = ConvertTo-FirefoxBridgePath ([IO.Path]::Combine($localPath, $name))
        if (-not (Test-FirefoxBridgePathEqual ([IO.Path]::GetDirectoryName($path)) $localPath)) {
            throw 'Ein erzeugter Dateipfad liegt ausserhalb von .local.'
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw "Die erzeugte Datei '$name' ist ein Ordner oder eine Verknuepfung. Es wird nichts entfernt."
        }
        $paths += $path
    }
    return [pscustomobject]@{ Project = $projectPath; Directory = $localPath; Files = $paths; Config = $paths[0]; Manifest = $paths[3] }
}

function Get-FirefoxBridgeRegistration {
    $key = Get-Item -LiteralPath 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge' -ErrorAction SilentlyContinue
    if (-not $key) { return [pscustomobject]@{ Exists = $false; Manifest = $null; HasChildren = $false } }
    try {
        return [pscustomobject]@{ Exists = $true; Manifest = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); HasChildren = $key.SubKeyCount -gt 0 }
    } finally { $key.Close() }
}

function Test-FirefoxBridgeRegistrationValue {
    param([AllowNull()][object]$First, [AllowNull()][object]$Second)
    if ($null -eq $First -or $null -eq $Second) { return $null -eq $First -and $null -eq $Second }
    if ($First.GetType() -ne $Second.GetType()) { return $false }
    if ($First -is [array]) {
        if ($First.Length -ne $Second.Length) { return $false }
        for ($index = 0; $index -lt $First.Length; $index++) {
            if (-not [object]::Equals($First[$index], $Second[$index])) { return $false }
        }
        return $true
    }
    return [object]::Equals($First, $Second)
}

function Remove-FirefoxBridgeRegistration {
    param([AllowNull()][object]$ExpectedManifest)
    $current = Get-FirefoxBridgeRegistration
    if (-not $current.Exists) { return }
    # Recheck the snapshot, not the location of the uninstaller. Even a stale or
    # malformed value belongs to this fixed application-specific registry key.
    if (-not (Test-FirefoxBridgeRegistrationValue $current.Manifest $ExpectedManifest)) {
        throw 'Die Native-Host-Registrierung wurde inzwischen geaendert und bleibt erhalten.'
    }
    if ($current.HasChildren) { throw 'Der Native-Host-Registrierungsschluessel enthaelt unerwartete Unterschluessel und bleibt erhalten.' }
    # Never recurse into registry children or remove any parent registration key.
    Remove-Item -LiteralPath 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge' -Force
}

function Get-FirefoxBridgeUninstallPaths {
    param($Registration)
    if (-not $Registration.Exists) { return Get-FirefoxBridgeLocalFiles }
    $manifestPath = if ($Registration.Manifest -is [string]) { ConvertTo-FirefoxBridgePath $Registration.Manifest } else { $null }
    if ($manifestPath -and [IO.Path]::GetFileName($manifestPath) -ieq 'de.codex.firefox_bridge.json') {
        $localPath = [IO.Path]::GetDirectoryName($manifestPath)
        if ([IO.Path]::GetFileName($localPath) -ieq '.local') {
            $projectPath = [IO.Path]::GetDirectoryName($localPath)
            if ($projectPath) {
                Write-Host ("Registrierter Installationspfad: " + $projectPath)
                return Get-FirefoxBridgeLocalFiles -ProjectPath $projectPath
            }
        }
    }
    Write-Host 'Die Registrierung enthaelt keinen erkennbaren Installationspfad. Es wird nur der Eintrag dieser Anwendung entfernt.'
    return $null
}

function Get-FirefoxBridgeProcessArguments {
    param([string]$CommandLine)
    if (-not ('FirefoxCodexMcpUninstall.NativeArguments' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FirefoxCodexMcpUninstall {
    public static class NativeArguments {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr pointer);
        public static string[] Read(string commandLine) {
            int count;
            IntPtr pointer = CommandLineToArgvW(commandLine, out count);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments.");
            try {
                string[] result = new string[count];
                for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
                return result;
            } finally { LocalFree(pointer); }
        }
    }
}
'@
    }
    return [FirefoxCodexMcpUninstall.NativeArguments]::Read($CommandLine)
}

function Get-FirefoxBridgeProcesses {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
}

function Test-FirefoxBridgeProcessOwnership {
    param($Snapshot, $Paths)
    if ($Snapshot.Name -ne 'node.exe' -or -not $Snapshot.CommandLine) { return $false }
    $arguments = @(Get-FirefoxBridgeProcessArguments $Snapshot.CommandLine)
    if ($arguments.Count -ne 4 -or $arguments[2] -cne '--config') { return $false }
    $nativeScript = [IO.Path]::Combine($Paths.Project, 'server\native-host.mjs')
    $mcpScript = [IO.Path]::Combine($Paths.Project, 'server\mcp.mjs')
    return ((Test-FirefoxBridgePathEqual $arguments[1] $nativeScript) -or (Test-FirefoxBridgePathEqual $arguments[1] $mcpScript)) -and (Test-FirefoxBridgePathEqual $arguments[3] $Paths.Config)
}

function Test-FirefoxBridgeCreationTime {
    param([datetime]$Actual, [datetime]$Expected)
    # Keep Int64 arithmetic: floating-point timestamp division loses precision.
    $actualTicks = $Actual.ToUniversalTime().Ticks
    $expectedTicks = $Expected.ToUniversalTime().Ticks
    return ($actualTicks - ($actualTicks % 10)) -eq ($expectedTicks - ($expectedTicks % 10))
}

function Stop-FirefoxBridgeProcess {
    param($Snapshot)
    try { $process = [Diagnostics.Process]::GetProcessById([int]$Snapshot.ProcessId) }
    catch [ArgumentException] { return } # The exact process has already exited.
    try {
        # Hold the process handle and compare creation times to avoid PID reuse.
        $null = $process.Handle
        if ($process.HasExited) { return }
        # CIM truncates to microseconds; Process.StartTime retains 100ns precision.
        if (-not $Snapshot.CreationDate -or -not (Test-FirefoxBridgeCreationTime $process.StartTime $Snapshot.CreationDate)) {
            throw 'Die Prozessidentitaet hat sich geaendert; kein Prozess wird beendet.'
        }
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { throw 'Der zugeordnete Bridge-Prozess wurde nicht rechtzeitig beendet.' }
    } finally { $process.Dispose() }
}

function Remove-FirefoxBridgeClientRegistrations {
    param([Parameter(Mandatory = $true)][string]$ProjectPath, [switch]$Preview)
    # A fresh download must still uninstall the native host without Node/npm.
    # Prefer its current registrar; use the installed copy only if needed.
    $scriptPath = $null
    foreach ($sourceRoot in @($PSScriptRoot, $ProjectPath)) {
        $candidate = [IO.Path]::Combine($sourceRoot, 'scripts\configure-clients.mjs')
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
            (Test-Path -LiteralPath ([IO.Path]::Combine($sourceRoot, 'node_modules\acorn\package.json')) -PathType Leaf) -and
            (Test-Path -LiteralPath ([IO.Path]::Combine($sourceRoot, 'node_modules\js-yaml\package.json')) -PathType Leaf)) {
            $scriptPath = $candidate
            break
        }
    }
    $nodePath = $null
    $nodeCandidates = @(
        [IO.Path]::Combine($PSScriptRoot, '.runtime\node\node.exe'),
        [IO.Path]::Combine($ProjectPath, '.runtime\node\node.exe')
    )
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $nodeCandidates += $command.Source }
    foreach ($candidate in $nodeCandidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $version = & $candidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
                $nodePath = $candidate
                break
            }
        } catch { }
    }
    if (-not $nodePath -or -not $scriptPath) {
        Write-Warning 'KI-Client-Eintraege bleiben erhalten: Node 22+ oder die Parserpakete fehlen. Native-Host-Deinstallation wird fortgesetzt. Zugehoerigen Firefox-MCP-Eintrag in den KI-Apps manuell entfernen (siehe README.md).'
        return
    }
    $arguments = @($scriptPath, '--remove', '--root', $ProjectPath)
    if ($Preview) { $arguments += '--dry-run' }
    try {
        & $nodePath @arguments
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Mindestens ein KI-Client-Eintrag bleibt erhalten; Details stehen oben. Native-Host-Deinstallation wird fortgesetzt.' }
    } catch {
        Write-Warning 'KI-Client-Eintraege konnten nicht bereinigt werden. Native-Host-Deinstallation wird fortgesetzt; passende Eintraege manuell entfernen.'
    }
}

function Invoke-FirefoxBridgeUninstall {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param()
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Diese Deinstallation ist fuer Windows bestimmt.' }
    $registration = Get-FirefoxBridgeRegistration
    if ($registration.Exists -and $registration.HasChildren) {
        throw 'Die Native-Host-Registrierung enthaelt unerwartete Unterschluessel und bleibt erhalten.'
    }
    $paths = Get-FirefoxBridgeUninstallPaths $registration
    $processes = @()
    if ($paths) {
        try { $processes = @(Get-FirefoxBridgeProcesses) }
        catch { throw 'Laufende Bridge-Prozesse konnten nicht sicher ermittelt werden. Firefox und die Codex-MCP-Verbindung beenden und die Deinstallation erneut starten.' }
    }
    $owned = @()
    foreach ($snapshot in $processes) {
        if (Test-FirefoxBridgeProcessOwnership $snapshot $paths) { $owned += $snapshot; continue }
        if (-not $snapshot.CommandLine) {
            Write-Warning 'Ein Node-Prozess ist nicht lesbar und wird nicht beendet. Firefox und Codex nach der Deinstallation neu starten.'
            continue
        }
        $arguments = @(Get-FirefoxBridgeProcessArguments $snapshot.CommandLine)
        foreach ($argument in $arguments) {
            if ((Test-FirefoxBridgePathEqual $argument ([IO.Path]::Combine($paths.Project, 'server\native-host.mjs'))) -or (Test-FirefoxBridgePathEqual $argument ([IO.Path]::Combine($paths.Project, 'server\mcp.mjs')))) {
                throw 'Ein moeglicher Bridge-Prozess konnte nicht eindeutig dieser Konfiguration zugeordnet werden und wird nicht beendet. Firefox/Codex beenden und erneut versuchen.'
            }
        }
    }
    # Unregister first so Firefox cannot relaunch this host while cleanup is running.
    if ($registration.Exists) {
        if ($PSCmdlet.ShouldProcess('HKCU Native Host de.codex.firefox_bridge', 'Registrierung dieser Anwendung entfernen')) { Remove-FirefoxBridgeRegistration $registration.Manifest }
    }
    foreach ($snapshot in $owned) {
        if ($PSCmdlet.ShouldProcess("Bridge-Prozess PID $($snapshot.ProcessId)", 'Nur diesen Projektprozess beenden')) { Stop-FirefoxBridgeProcess $snapshot }
    }
    if ($paths) {
        try {
            if ($WhatIfPreference) {
                Remove-FirefoxBridgeClientRegistrations -ProjectPath $paths.Project -Preview
            } elseif ($PSCmdlet.ShouldProcess($paths.Project, 'Zugehoerige Firefox-MCP-Eintraege aus erkannten KI-Clients entfernen')) {
                Remove-FirefoxBridgeClientRegistrations -ProjectPath $paths.Project
            }
        } catch {
            Write-Warning 'Die optionale KI-Client-Bereinigung ist nicht verfuegbar. Native-Host-Deinstallation wird fortgesetzt; passende Eintraege manuell pruefen.'
        }
        foreach ($file in $paths.Files) {
            # Revalidate links immediately before each deletion; never recurse.
            $null = Get-FirefoxBridgeLocalFiles -ProjectPath $paths.Project
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                if ($PSCmdlet.ShouldProcess($file, 'Erzeugte lokale Datei entfernen')) {
                    $null = Get-FirefoxBridgeLocalFiles -ProjectPath $paths.Project
                    Remove-Item -LiteralPath $file -Force
                }
            }
        }
        $null = Get-FirefoxBridgeLocalFiles -ProjectPath $paths.Project
        if ((Test-Path -LiteralPath $paths.Directory -PathType Container) -and @(Get-ChildItem -LiteralPath $paths.Directory -Force).Count -eq 0) {
            if ($PSCmdlet.ShouldProcess($paths.Directory, 'Leeren .local-Ordner entfernen')) { [IO.Directory]::Delete($paths.Directory, $false) }
        } elseif (Test-Path -LiteralPath $paths.Directory -PathType Container) { Write-Host 'Weitere Dateien in .local bleiben erhalten.' }
    }
    if ($WhatIfPreference) { Write-Host 'Vorschau beendet; es wurden keine Aenderungen vorgenommen.' }
    else { Write-Host 'Die Registrierung dieser Anwendung und ihre zuordenbaren lokalen Bridge-Dateien wurden entfernt, soweit vorhanden.' }
    Write-Host 'Firefox-Erweiterung bei Bedarf unter about:addons manuell entfernen.'
    Write-Host 'Uebersprungene oder nachtraeglich geaenderte Firefox-MCP-Eintraege gegebenenfalls manuell entfernen; andere Server bleiben unveraendert.'
    Write-Host 'Firefox und betroffene KI-Apps anschliessend neu starten; nicht sicher zugeordnete Prozesse werden niemals beendet.'
}

# Dot-sourcing exposes the small boundaries for isolated tests, but performs no work.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-FirefoxBridgeUninstall @PSBoundParameters }
    catch { Write-Error ("Deinstallation abgebrochen: " + $_.Exception.Message); exit 1 }
}
