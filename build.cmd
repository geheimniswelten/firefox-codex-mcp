@echo off
setlocal DisableDelayedExpansion
rem Keep Windows PowerShell 5.1 independent of PowerShell 7 module paths.
set "PSModulePath="
echo Firefox - Codex MCP: ZIPs bauen
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "operationExit=%errorlevel%"
echo.
if "%operationExit%" == "0" (
    echo Build erfolgreich. Die ZIPs liegen im Ordner dist.
) else (
    echo Build fehlgeschlagen. Fehlercode: %operationExit%
)
choice /C 0 /N /M "Zum Schliessen 0 druecken: "
exit /b %operationExit%
