param([Parameter(Mandatory = $true)][string]$Request)
# All shared-file operations, including reads, run inside the C# global mutex.
# ASCII source for Windows PowerShell 5.1. No user-supplied code is evaluated.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $options = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-port-reservation.cs')
    $result = [FirefoxMcp.PortReservation]::Run([string]$options.action, [int]$options.port, [string]$options.directory)
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    $code = 'PORT_RESERVATION_FAILED'
    if ($failure.GetType().FullName -eq 'FirefoxMcp.PortFailure') { $code = $failure.Code }
    @{ error = @{ code = $code; message = $failure.Message } } | ConvertTo-Json -Compress
    exit 1
}
