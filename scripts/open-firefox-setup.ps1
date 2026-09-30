# Opening this interactive page is requested by the user after installation.
# Dot-sourcing only defines the functions; it does not start Firefox.
function Find-FirefoxExecutable {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    # Prefer the running Firefox, including a portable/custom installation.
    foreach ($process in @(Get-Process -Name firefox -ErrorAction SilentlyContinue)) {
        try {
            if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.Path) { $candidates.Add($process.Path) }
        } catch { }
    }
    foreach ($keyPath in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe'
    )) {
        $key = Get-Item -LiteralPath $keyPath -ErrorAction SilentlyContinue
        if ($key) {
            try {
                $value = $key.GetValue('')
                if ($value -is [string] -and $value) { $candidates.Add($value.Trim('"')) }
            } finally { $key.Close() }
        }
    }
    $command = Get-Command firefox.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $candidates.Add($command.Source) }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
        if ($base) { $candidates.Add([IO.Path]::Combine($base, 'Mozilla Firefox\firefox.exe')) }
    }
    if ($env:LOCALAPPDATA) { $candidates.Add([IO.Path]::Combine($env:LOCALAPPDATA, 'Mozilla Firefox\firefox.exe')) }
    foreach ($candidate in $candidates) {
        if ([IO.Path]::IsPathRooted($candidate) -and [IO.File]::Exists($candidate)) { return $candidate }
    }
    return $null
}

function Open-FirefoxSetupPage {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $url = 'about:debugging#/runtime/this-firefox'
    Write-Host ('Firefox-Einrichtung: ' + $url)
    Write-Host ('Dort unter "Temporaeres Add-on laden" auswaehlen: ' + [IO.Path]::Combine($ProjectRoot, 'extension\manifest.json'))
    $firefoxPath = Find-FirefoxExecutable
    if (-not $firefoxPath) {
        Write-Warning 'Firefox wurde nicht gefunden. Bitte die angezeigte Adresse manuell in Firefox oeffnen.'
        return $false
    }
    # Firefox handles routing to an existing instance; no profile is changed.
    Start-Process -FilePath $firefoxPath -ArgumentList @('-new-tab', $url) -WindowStyle Normal -ErrorAction Stop
    return $true
}
