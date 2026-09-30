@echo off
setlocal DisableDelayedExpansion
rem Avoid importing PowerShell 7 module paths into Windows PowerShell 5.1.
set "PSModulePath="
echo Firefox - Codex MCP
echo.
echo [1] Erzeugen + Installieren
echo [2] Nur Erzeugen
echo [3] Deinstallieren
echo [0] Beenden
echo.
choice /C 1230 /N /M "Auswahl [1/2/3/0]: "
if errorlevel 255 goto choice_error
if errorlevel 4 goto cancelled
if errorlevel 3 goto uninstall
if errorlevel 2 goto generate
if errorlevel 1 goto install
goto cancelled

:install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "operationExit=%errorlevel%"
goto result

:generate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -GenerateOnly
set "operationExit=%errorlevel%"
goto result

:uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set "operationExit=%errorlevel%"
goto result

:choice_error
echo Das Auswahlmenue konnte nicht gestartet werden.
set "operationExit=1"
goto result

:cancelled
exit /b 0

:result
echo.
if "%operationExit%"=="0" (
    echo Vorgang erfolgreich abgeschlossen. Bitte die angezeigten naechsten Schritte beachten.
) else (
    echo Vorgang fehlgeschlagen. Fehlercode: %operationExit%
)
pause
exit /b %operationExit%
