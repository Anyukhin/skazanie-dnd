$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskRuntime = Join-Path $PSScriptRoot 'tmp/sites-runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskPidFile = Join-Path $taskRuntime 'manager.pid'
$taskManagerScript = Join-Path $PSScriptRoot 'tools/sites-local-server.mjs'
if (Test-Path -LiteralPath $taskPidFile) {
  $taskPrevious = Get-CimInstance Win32_Process -Filter "ProcessId = $([int](Get-Content -LiteralPath $taskPidFile))"
  if ($taskPrevious.CommandLine -and $taskPrevious.CommandLine.Contains($taskManagerScript)) {
    Write-Host 'Сервер Sites уже запущен.'
    exit 0
  }
}
$taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $taskNode) { $taskNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Нужен Node.js 20.19 или новее.' }
$taskManager = Start-Process -FilePath $taskNode -ArgumentList @('"' + $taskManagerScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRuntime 'manager.log') -RedirectStandardError (Join-Path $taskRuntime 'manager-error.log') -PassThru
$taskManager.Id | Set-Content -LiteralPath $taskPidFile
Write-Host 'Запущен сервер «Сказания» для Sites. Docker не требуется.'
Write-Host 'Для остановки используйте STOP_SITES_DND.cmd.'
