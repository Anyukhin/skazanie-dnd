@echo off
setlocal
title DnD - Skazanie
chcp 65001 >nul
cd /d "%~dp0"
set "DND_PROJECT_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$script = Get-Content -LiteralPath '%~dp0Start-DnD.ps1' -Raw -Encoding UTF8; & ([ScriptBlock]::Create($script))"
set "LAUNCH_EXIT=%ERRORLEVEL%"
if not "%LAUNCH_EXIT%"=="0" (
  echo.
  echo START_DND failed. The diagnostic message is shown above.
  pause
)
exit /b %LAUNCH_EXIT%
