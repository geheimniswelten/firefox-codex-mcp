param(
    [switch]$SkipDependencies,
    [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$originalProcessPath = $env:PATH
$locationPushed = $false
try {
    . (Join-Path $projectRoot 'scripts\node-runtime.ps1')
    $runtime = Resolve-FirefoxNodeRuntime -ProjectRoot $projectRoot -NoDownload:$NoDownload
    $env:PATH = [IO.Path]::GetDirectoryName($runtime.NodePath) + ';' + $originalProcessPath
    Write-Host ('Node.js: ' + $runtime.NodePath)
    Push-Location -LiteralPath $projectRoot
    $locationPushed = $true

    if (-not $SkipDependencies) {
        Write-Host 'Build-Abhaengigkeiten aus der Lockdatei installieren ...'
        if ($runtime.NpmCliPath) {
            & $runtime.NodePath $runtime.NpmCliPath ci --include=dev
        } else {
            & $runtime.NpmCommandPath ci --include=dev
        }
        if ($LASTEXITCODE -ne 0) { throw 'npm ci ist fehlgeschlagen.' }
    }

    Write-Host 'JavaScript und Manifest pruefen ...'
    & $runtime.NodePath (Join-Path $projectRoot 'scripts\check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Die Syntax-/Manifestpruefung ist fehlgeschlagen.' }

    Write-Host 'Bundle, Einrichtungsskripte und ZIPs neu bauen ...'
    & $runtime.NodePath (Join-Path $projectRoot 'scripts\package.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Die Paketierung ist fehlgeschlagen.' }

    Write-Host 'Lokalen AMO-Linter ausfuehren ...'
    & $runtime.NodePath (Join-Path $projectRoot 'node_modules\web-ext\bin\web-ext.js') lint --source-dir extension
    if ($LASTEXITCODE -ne 0) { throw 'Der lokale AMO-Linter meldet einen Fehler.' }

    Write-Host ''
    Write-Host 'Build fertig:' -ForegroundColor Green
    Write-Host (Join-Path $projectRoot 'dist\firefox-codex-mcp-extension.zip')
    Write-Host (Join-Path $projectRoot 'dist\firefox-codex-mcp-source.zip')
    Write-Host 'Das Add-on-ZIP ist unsigniert. Die vorhandene Versionsnummer wird verwendet.'
} catch {
    Write-Host ('Build fehlgeschlagen: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locationPushed) { Pop-Location }
    $env:PATH = $originalProcessPath
}
