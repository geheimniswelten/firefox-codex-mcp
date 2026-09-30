param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 38477,
    [switch]$GenerateOnly,
    [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$originalProcessPath = $env:PATH
$locationPushed = $false
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
    $setupArgs = @((Join-Path $projectRoot 'scripts\setup.mjs'))
    if ($PSBoundParameters.ContainsKey('Port')) { $setupArgs += @('--port', "$Port") }
    if (-not $GenerateOnly) { $setupArgs += '--register-native' }
    & $runtime.NodePath @setupArgs
    if ($LASTEXITCODE -ne 0) { throw 'Native-Host-Einrichtung ist fehlgeschlagen.' }
    Write-Host 'Danach Firefox-Erweiterung laden und .local\codex-config.toml in Codex uebernehmen. Siehe README.md.'
} catch {
    Write-Host ''
    Write-Host ("Installation fehlgeschlagen: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locationPushed) { Pop-Location }
    $env:PATH = $originalProcessPath
}
