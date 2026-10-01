$ErrorActionPreference = 'Stop'
$taskRuntime = Join-Path $PSScriptRoot 'tmp/sites-runtime'
$taskChildrenFile = Join-Path $taskRuntime 'children.json'
if (Test-Path -LiteralPath $taskChildrenFile) {
  $taskChildren = Get-Content -Raw -LiteralPath $taskChildrenFile | ConvertFrom-Json
  foreach ($taskChild in @(@{ id = $taskChildren.tunnel; script = (Join-Path $taskRuntime 'tunnel-key') }, @{ id = $taskChildren.server; script = (Join-Path $PSScriptRoot 'server/index.mjs') })) {
    if (-not $taskChild.id) { continue }
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskChild.id)"
    if ($taskProcess.CommandLine -and $taskProcess.CommandLine.Contains($taskChild.script)) { Stop-Process -Id $taskChild.id -ErrorAction SilentlyContinue }
  }
}
$taskPidFile = Join-Path $taskRuntime 'manager.pid'
if (Test-Path -LiteralPath $taskPidFile) {
  $taskManagerId = [int](Get-Content -LiteralPath $taskPidFile)
  $taskManager = Get-CimInstance Win32_Process -Filter "ProcessId = $taskManagerId"
  if ($taskManager.CommandLine -and $taskManager.CommandLine.Contains((Join-Path $PSScriptRoot 'tools/sites-local-server.mjs'))) { Stop-Process -Id $taskManagerId -ErrorAction SilentlyContinue }
}
Write-Host 'Сервер Sites остановлен. Сохранения остаются на компьютере.'
