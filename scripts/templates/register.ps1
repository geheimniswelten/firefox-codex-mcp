param(
    [string]$ProjectRoot,
    [switch]$NoDownload,
    [switch]$NoRegisterClients,
    [ValidateRange(1024, 65535)][int]$Port = 38477,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
# Generated from reviewed sources; archive contents are listed in payload-manifest.json.
# Companion version: __VERSION__; registration revision: __REVISION__.
__COMMON_PS__

function Expand-FirefoxSetupPayload {
    param([Parameter(Mandatory = $true)][string]$Root)
    $compressed = [Convert]::FromBase64String('__PAYLOAD__')
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $actual = [BitConverter]::ToString($sha.ComputeHash($compressed)).Replace('-', '').ToLowerInvariant()
        if ($actual -ne '__PAYLOAD_SHA__') { throw 'Companion archive checksum failed.' }
    } finally { $sha.Dispose() }
    $inputStream = New-Object IO.MemoryStream(,$compressed)
    $gzip = New-Object IO.Compression.GZipStream($inputStream, [IO.Compression.CompressionMode]::Decompress)
    $reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)
    try { $payload = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose(); $gzip.Dispose(); $inputStream.Dispose() }
    if ($payload.schemaVersion -ne 1 -or $payload.version -ne '__VERSION__' -or @($payload.files).Count -gt 200) { throw 'Unexpected companion payload.' }
    $Root = [IO.Path]::GetFullPath($Root)
    Assert-FirefoxOrdinaryPath -Path $Root -Directory
    $packagePath = Join-Path $Root 'package.json'
    Assert-FirefoxOrdinaryPath -Path $packagePath
    if ([IO.File]::Exists($packagePath)) {
        $previous = [IO.File]::ReadAllText($packagePath) | ConvertFrom-Json
        if ($previous.name -ne 'firefox-codex-mcp') { throw 'This directory belongs to another application.' }
    }
    $destinations = New-Object 'System.Collections.Generic.List[object]'
    $seen = @{}
    foreach ($file in $payload.files) {
        if ($file.path -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$' -or @($file.path.Split('/') | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or $seen.ContainsKey($file.path)) { throw 'Invalid companion path.' }
        $seen[$file.path] = $true
        $target = [IO.Path]::GetFullPath((Join-Path $Root $file.path))
        if (-not $target.StartsWith($Root.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Companion path escaped installation directory.' }
        Assert-FirefoxOrdinaryPath -Path $target
        $bytes = [Convert]::FromBase64String($file.data)
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        if ($actual -ne $file.sha256 -or $bytes.Length -gt 4194304) { throw 'Companion file checksum failed.' }
        $destinations.Add([pscustomobject]@{ Path = $target; Bytes = $bytes })
    }
    foreach ($needed in @('package.json', 'package-lock.json', 'scripts/setup.mjs', 'scripts/install-companion.mjs', 'server/native-host.mjs')) {
        if (-not $seen.ContainsKey($needed)) { throw ('Incomplete companion payload: ' + $needed) }
    }
    foreach ($file in $destinations) {
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file.Path))
        $temp = $file.Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllBytes($temp, $file.Bytes)
            # Replace the directory entry rather than writing through hardlinks.
            if ([IO.File]::Exists($file.Path)) { [IO.File]::Replace($temp, $file.Path, [NullString]::Value) }
            else { [IO.File]::Move($temp, $file.Path) }
        } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
    }
}

if ($Help) {
    Write-Host 'register.ps1 [-ProjectRoot ABSOLUTE_DIRECTORY] [-NoDownload] [-NoRegisterClients] [-Port 38477]'
    Write-Host 'Self-contained companion setup. Existing source files in the selected directory are updated.'
    exit 0
}
try {
    $root = Get-FirefoxSetupRoot -RequestedRoot $ProjectRoot
    Expand-FirefoxSetupPayload -Root $root
    $arguments = @{ NoOpenFirefox = $true }
    if ($NoDownload) { $arguments.NoDownload = $true }
    if ($NoRegisterClients) { $arguments.NoRegisterClients = $true }
    if ($PSBoundParameters.ContainsKey('Port')) { $arguments.Port = $Port }
    & (Join-Path $root 'install.ps1') @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Return to the extension settings and choose Check again.'
} catch {
    Write-Host ('Registration failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
