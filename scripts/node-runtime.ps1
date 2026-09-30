# Portable Node.js fallback. Dot-source this file; no work runs on import.
# Keep ASCII for Windows PowerShell 5.1 without a UTF-8 BOM.

function Test-FirefoxNodeVersion {
    param([string]$NodePath)
    if (-not [IO.File]::Exists($NodePath)) { return $false }
    try {
        $version = & $NodePath --version 2>$null
        return $LASTEXITCODE -eq 0 -and $version -is [string] -and $version -match '^v(?<Major>[0-9]+)\.[0-9]+\.[0-9]+(?:[-+].*)?$' -and [int]$Matches.Major -ge 22
    } catch { return $false }
}

function Get-FirefoxNodeRuntimeCandidate {
    param([string]$NodePath, [AllowNull()][string]$NpmCommandPath)
    if (-not [IO.File]::Exists($NodePath)) { return $null }
    $nodeDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($NodePath))
    $npmCli = [IO.Path]::Combine($nodeDirectory, 'node_modules\npm\bin\npm-cli.js')
    if (-not [IO.File]::Exists($npmCli)) {
        $npmCli = $null
        if (-not $NpmCommandPath -or -not [IO.File]::Exists($NpmCommandPath)) { return $null }
    }
    if (-not (Test-FirefoxNodeVersion -NodePath $NodePath)) { return $null }
    return [pscustomobject]@{
        NodePath = [IO.Path]::GetFullPath($NodePath)
        NpmCliPath = $npmCli
        NpmCommandPath = if ($npmCli) { $null } else { [IO.Path]::GetFullPath($NpmCommandPath) }
    }
}

function Find-FirefoxSystemNodeRuntime {
    $directories = New-Object 'System.Collections.Generic.List[string]'
    $nodeCandidates = New-Object 'System.Collections.Generic.List[string]'
    $npmCandidates = New-Object 'System.Collections.Generic.List[string]'
    foreach ($command in @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $nodeCandidates.Add($command.Source) }
    }
    foreach ($command in @(Get-Command npm.cmd -All -CommandType Application -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $npmCandidates.Add($command.Source) }
    }
    # A shell opened before installing Node may have a stale process PATH.
    $searchPaths = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'))
    foreach ($searchPath in $searchPaths) {
        if (-not $searchPath) { continue }
        foreach ($directory in ($searchPath -split ';')) {
            $directory = [Environment]::ExpandEnvironmentVariables($directory.Trim().Trim('"'))
            if ($directory -and [IO.Path]::IsPathRooted($directory)) { $directories.Add($directory) }
        }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
        if ($base) { $directories.Add([IO.Path]::Combine($base, 'nodejs')) }
    }
    if ($env:LOCALAPPDATA) {
        $directories.Add([IO.Path]::Combine($env:LOCALAPPDATA, 'Programs\nodejs'))
        $directories.Add([IO.Path]::Combine($env:LOCALAPPDATA, 'nodejs'))
    }
    foreach ($directory in @($directories | Select-Object -Unique)) {
        $nodeCandidates.Add([IO.Path]::Combine($directory, 'node.exe'))
        $npmCandidates.Add([IO.Path]::Combine($directory, 'npm.cmd'))
    }
    $fallbackNpm = $npmCandidates | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
    foreach ($nodePath in @($nodeCandidates | Select-Object -Unique)) {
        $runtime = Get-FirefoxNodeRuntimeCandidate -NodePath $nodePath -NpmCommandPath $fallbackNpm
        if ($runtime) { return $runtime }
    }
    return $null
}

function Get-FirefoxNodeArchitecture {
    $architecture = $null
    try { $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
    if (-not $architecture) {
        $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($architecture) {
        '^(X64|AMD64)$' { return 'x64' }
        '^ARM64$' { return 'arm64' }
        default { throw 'Automatic Node.js download supports Windows x64 and ARM64 only. Install Node.js 22 or newer with npm for your system.' }
    }
}

function Invoke-FirefoxNodeDownload {
    param([string]$Uri, [AllowNull()][string]$OutFile)
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    $ProgressPreference = 'SilentlyContinue'
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        if ($OutFile) {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile -TimeoutSec 180 -ErrorAction Stop
            return
        }
        $content = (Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 30 -ErrorAction Stop).Content
        if ($content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($content) }
        return [string]$content
    } finally { [Net.ServicePointManager]::SecurityProtocol = $previousTls }
}

function Get-FirefoxNodeRelease {
    param([string]$Checksums, [ValidateSet('x64', 'arm64')][string]$Architecture)
    $pattern = '(?m)^(?<Hash>[a-fA-F0-9]{64})[ \t]+\*?(?<File>node-v(?<Version>24\.[0-9]+\.[0-9]+)-win-' + $Architecture + '\.zip)\r?$'
    $entries = [regex]::Matches($Checksums, $pattern)
    if ($entries.Count -ne 1) { throw 'The official Node.js 24 checksum list did not contain exactly one matching Windows ZIP.' }
    return [pscustomobject]@{
        Hash = $entries[0].Groups['Hash'].Value
        File = $entries[0].Groups['File'].Value
        Version = $entries[0].Groups['Version'].Value
    }
}

function Assert-FirefoxNodeDirectory {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw "The runtime path must be a regular directory, not a file or link: $Path"
    }
}

function Expand-FirefoxNodeArchive {
    param([string]$ArchivePath, [string]$DestinationPath)
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -ErrorAction Stop
}

function Remove-FirefoxNodeStage {
    param([string]$RuntimeRoot, [string]$StagePath)
    $runtimeFull = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([char[]]'\/')
    $stageFull = [IO.Path]::GetFullPath($StagePath).TrimEnd([char[]]'\/')
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($stageFull), $runtimeFull, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($stageFull) -notmatch '^download-[a-f0-9]{32}$') {
        throw 'Refusing to remove an unexpected runtime staging path.'
    }
    Assert-FirefoxNodeDirectory -Path $runtimeFull
    Assert-FirefoxNodeDirectory -Path $stageFull
    if ([IO.Directory]::Exists($stageFull)) { Remove-Item -LiteralPath $stageFull -Recurse -Force -ErrorAction Stop }
}

function Resolve-FirefoxNodeRuntime {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot, [switch]$NoDownload)
    if (-not [IO.Path]::IsPathRooted($ProjectRoot)) { throw 'ProjectRoot must be an absolute directory path.' }
    $projectFull = [IO.Path]::GetFullPath($ProjectRoot)
    if (-not [IO.Directory]::Exists($projectFull)) { throw 'The project directory does not exist.' }
    $runtimeRoot = [IO.Path]::Combine($projectFull, '.runtime')
    $nodeDirectory = [IO.Path]::Combine($runtimeRoot, 'node')
    Assert-FirefoxNodeDirectory -Path $runtimeRoot
    Assert-FirefoxNodeDirectory -Path $nodeDirectory
    $runtime = Get-FirefoxNodeRuntimeCandidate -NodePath ([IO.Path]::Combine($nodeDirectory, 'node.exe'))
    if ($runtime) { return $runtime }
    $runtime = Find-FirefoxSystemNodeRuntime
    if ($runtime) { return $runtime }
    if ($NoDownload) { throw 'Node.js 22 or newer with npm was not found. Run install.cmd to download a project-local runtime, or install Node.js with npm and open a new terminal.' }
    if (Test-Path -LiteralPath $nodeDirectory) {
        throw 'The existing .runtime\node directory is incomplete or too old and was preserved. Move it aside, or install Node.js 22 or newer with npm, then rerun install.cmd.'
    }
    $architecture = Get-FirefoxNodeArchitecture
    Write-Host "Node.js with npm was not found. Downloading official Node.js 24 LTS ($architecture) into .runtime\node."
    $release = Get-FirefoxNodeRelease -Checksums (Invoke-FirefoxNodeDownload -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') -Architecture $architecture
    Assert-FirefoxNodeDirectory -Path $runtimeRoot
    $null = [IO.Directory]::CreateDirectory($runtimeRoot)
    $stage = [IO.Path]::Combine($runtimeRoot, ('download-' + [guid]::NewGuid().ToString('N')))
    $null = [IO.Directory]::CreateDirectory($stage)
    try {
        $archivePath = [IO.Path]::Combine($stage, $release.File)
        # Bind the ZIP to the version from the checksum list, not the mutable alias.
        $uri = 'https://nodejs.org/dist/v' + $release.Version + '/' + $release.File
        Invoke-FirefoxNodeDownload -Uri $uri -OutFile $archivePath
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256 -ErrorAction Stop).Hash
        if (-not [string]::Equals($actualHash, $release.Hash, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The Node.js download failed its SHA256 check. Nothing was installed. Run install.cmd again.'
        }
        $extracted = [IO.Path]::Combine($stage, 'extracted')
        Expand-FirefoxNodeArchive -ArchivePath $archivePath -DestinationPath $extracted
        $packageRoot = [IO.Path]::Combine($extracted, [IO.Path]::GetFileNameWithoutExtension($release.File))
        Assert-FirefoxNodeDirectory -Path $packageRoot
        if (-not (Get-FirefoxNodeRuntimeCandidate -NodePath ([IO.Path]::Combine($packageRoot, 'node.exe')))) {
            throw 'The extracted Node.js runtime or its bundled npm is not usable. Nothing was installed.'
        }
        Assert-FirefoxNodeDirectory -Path $runtimeRoot
        if (Test-Path -LiteralPath $nodeDirectory) { throw 'The runtime destination appeared during setup and was preserved. Run install.cmd again.' }
        [IO.Directory]::Move($packageRoot, $nodeDirectory)
        return [pscustomobject]@{
            NodePath = [IO.Path]::Combine($nodeDirectory, 'node.exe')
            NpmCliPath = [IO.Path]::Combine($nodeDirectory, 'node_modules\npm\bin\npm-cli.js')
            NpmCommandPath = $null
        }
    } finally {
        try { Remove-FirefoxNodeStage -RuntimeRoot $runtimeRoot -StagePath $stage }
        catch { Write-Warning ('Temporary runtime files could not be removed: ' + $_.Exception.Message) }
    }
}
