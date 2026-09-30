param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 38477,
    [switch]$GenerateOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) { throw 'Node.js 22 oder neuer wird benötigt. Node installieren und PowerShell neu öffnen.' }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCommand) { throw 'npm wurde nicht gefunden. Bitte die Node.js-Installation prüfen.' }
$major = & $nodeCommand.Source -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw 'Node.js 22 oder neuer wird benötigt.' }

Push-Location -LiteralPath $projectRoot
try {
    & $npmCommand.Source ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm ci ist fehlgeschlagen.' }
    $setupArgs = @((Join-Path $projectRoot 'scripts\setup.mjs'))
    if ($PSBoundParameters.ContainsKey('Port')) { $setupArgs += @('--port', "$Port") }
    if (-not $GenerateOnly) { $setupArgs += '--register-native' }
    & $nodeCommand.Source @setupArgs
    if ($LASTEXITCODE -ne 0) { throw 'Native-Host-Einrichtung ist fehlgeschlagen.' }
    Write-Host 'Danach Firefox-Erweiterung laden und .local\codex-config.toml in Codex übernehmen. Siehe README.md.'
} finally {
    Pop-Location
}
