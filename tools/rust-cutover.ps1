# Разовый перенос хранилища JS-сервера в Rust-сервер и переключение игры на
# Rust — шаги «Переключение на 8787» из docs/rust-docker.md одним запуском.
# ./storage только читается (монтируется :ro); откат — DND_SERVER=js в .env
# и START_DND.cmd. Игры, сыгранные на Rust, обратно в JS не переносятся.
#
#   powershell -ExecutionPolicy Bypass -File tools\rust-cutover.ps1
#     -DryRun        только пробный перенос и сводка; JS-сервер возвращается
#     -NoBuild       не пересобирать образ skazanie-rust:local
#     -ProjectRoot   папка с .env, storage и local-ca (по умолчанию текущая)
#     -SourceRoot    копия репозитория, из которой собирать образ и брать
#                    compose.rust.yaml (по умолчанию — папка этого скрипта),
#                    когда в основной папке другая ветка
param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$DryRun,
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
Set-Location -LiteralPath $ProjectRoot
$Storage = Join-Path $ProjectRoot 'storage'
$EnvFile = Join-Path $ProjectRoot '.env'
$Rust = @('compose', '-f', (Join-Path $SourceRoot 'compose.rust.yaml'), '--project-directory', $ProjectRoot)
$Js = @('compose', '-f', (Join-Path $ProjectRoot 'compose.yaml'), '--project-directory', $ProjectRoot)

function Write-Step([string]$Message) { Write-Host $Message -ForegroundColor Cyan }

function Invoke-Docker([string[]]$Arguments, [int[]]$Allowed = @(0)) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & docker @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($Allowed -notcontains $code) { throw "docker $($Arguments[0..2] -join ' ') … завершился с кодом $code." }
  return $code
}

function Get-Quiet([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $output = & docker @Arguments 2>$null | Out-String
    return @{ Code = $LASTEXITCODE; Output = $output.Trim() }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

# Записать NAME=value в .env: заменить строку NAME= или дописать. Значения не печатаются.
function Set-EnvValue([string]$Name, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $EnvFile) { $lines = @(Get-Content -LiteralPath $EnvFile -Encoding UTF8) }
  $pattern = "^$([regex]::Escape($Name))="
  $found = $false
  $lines = @($lines | ForEach-Object {
    if ($_ -match $pattern) { if (-not $found) { $found = $true; "$Name=$Value" } } else { $_ }
  })
  if (-not $found) { $lines += "$Name=$Value" }
  [IO.File]::WriteAllLines($EnvFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
}

function Read-EnvValue([string]$Name) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
  $line = Get-Content -LiteralPath $EnvFile -Encoding UTF8 | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

# Копия ./storage новыми файлами (байты и время), без расширенных атрибутов:
# в них Docker Desktop хранит владельца и режим Linux, и файлы, записанные
# JS-контейнером (uid 1000, режим 0600), Rust-контейнер (uid 10001) не прочтёт.
# Отметку писателя не копировать — это не данные (её пропускает и pnpm backup).
function Copy-PlainTree([string]$From, [string]$To) {
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
    $target = Join-Path $To $item.Name
    if ($item.PSIsContainer) { Copy-PlainTree $item.FullName $target; continue }
    if ($item.Name -eq '.server-writer.json' -and $From -eq $Storage) { continue }
    [IO.File]::WriteAllBytes($target, [IO.File]::ReadAllBytes($item.FullName))
    [IO.File]::SetLastWriteTimeUtc($target, $item.LastWriteTimeUtc)
  }
}

$jsWasRunning = $false
$switched = $false
try {
  if (-not (Test-Path -LiteralPath (Join-Path $Storage 'engine\campaigns'))) {
    throw "В $Storage нет engine\campaigns — переносить нечего."
  }
  if ((Get-Quiet @('info')).Code -ne 0) { throw 'Docker не отвечает — запустите Docker Desktop.' }

  $script:jsWasRunning = [bool](Get-Quiet ($Js + @('ps', '-q', 'skazanie'))).Output
  Write-Step 'Останавливаю JS-сервер и туннель (перенос читает ./storage без писателя)...'
  [void](Invoke-Docker ($Js + @('--profile', 'public', 'stop')))

  if (-not $NoBuild) {
    Write-Step "Собираю образ skazanie-rust:local из $SourceRoot (первая сборка — до получаса)..."
    [void](Invoke-Docker @('build', '-f', (Join-Path $SourceRoot 'Dockerfile.rust'), '-t', 'skazanie-rust:local', $SourceRoot))
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $ProjectRoot "backups\storage-before-rust-$stamp"
  Write-Step "Копия ./storage — $backup (перенос идёт из неё)..."
  Copy-PlainTree $Storage $backup
  $LegacyMount = ($backup -replace '\\', '/') + ':/legacy-storage:ro'

  # Пробный перенос — без тома Rust-сервиса: ничего не пишет и том не создаёт.
  Write-Step 'Пробный перенос (ничего не пишет)...'
  $dry = Invoke-Docker @('run', '--rm', '-v', $LegacyMount, 'skazanie-rust:local', 'import-legacy', '--from', '/legacy-storage', '--dry-run') @(0, 3)
  if ($dry -eq 3) { throw 'Пробный перенос пропустил часть кампаний или комнат (причины выше) — разобраться до настоящего переноса.' }
  if ($DryRun) {
    if ($jsWasRunning) { [void](Invoke-Docker ($Js + @('--profile', 'public', 'start'))) }
    Write-Host 'Пробный перенос чистый. Без -DryRun скрипт перенесёт хранилище и переключит игру.' -ForegroundColor Green
    Write-Host "Копию $backup после пробы можно удалить." -ForegroundColor DarkGray
    exit 0
  }

  Write-Step 'Перенос в том skazanie-rust_storage...'
  [void](Invoke-Docker ($Rust + @('run', '--rm', '--no-deps', '-v', $LegacyMount, 'skazanie-rust', 'import-legacy', '--from', '/legacy-storage')))

  Write-Step 'Аудит перенесённого хранилища (журнал против replay, проекции, комнаты)...'
  $audit = Invoke-Docker ($Rust + @('run', '--rm', '--no-deps', 'skazanie-rust', 'audit-storage')) @(0, 1)
  if ($audit -ne 0) { throw 'Аудит нашёл блокеры (выше). Игра остаётся на JS: docker compose --profile public up -d.' }

  Set-EnvValue 'DND_SERVER' 'rust'
  Set-EnvValue 'SKAZANIE_RUST_PORT' '8787'
  if ((Test-Path -LiteralPath (Join-Path $ProjectRoot 'local-ca\kaspersky-root.pem')) -and -not (Read-EnvValue 'DND_EXTRA_CA_CERTS')) {
    Set-EnvValue 'DND_EXTRA_CA_CERTS' '/app/local-ca/kaspersky-root.pem'
  }

  Write-Step 'Запускаю Rust-сервер на 8787 с публичной ссылкой...'
  $switched = $true
  $env:SKAZANIE_RUST_PORT = '8787'
  [void](Invoke-Docker ($Rust + @('--profile', 'public', 'up', '-d')))
  $deadline = (Get-Date).AddSeconds(120)
  $healthy = $false
  while ((Get-Date) -lt $deadline -and -not $healthy) {
    try { $healthy = (Invoke-WebRequest -UseBasicParsing -Method Head 'http://127.0.0.1:8787/api/health' -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $healthy) { throw 'Rust-сервер не ответил на /api/health: docker compose -f compose.rust.yaml logs skazanie-rust.' }

  Write-Host ''
  Write-Host 'Игра переключена на Rust: http://127.0.0.1:8787' -ForegroundColor Green
  Write-Host "В .env: DND_SERVER=rust. Копия прежнего хранилища — $backup" -ForegroundColor DarkGray
  Write-Host 'Откат: DND_SERVER=js в .env и START_DND.cmd (./storage не изменён).' -ForegroundColor DarkGray
  exit 0
} catch {
  Write-Host ''
  Write-Host 'Перенос остановлен:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($jsWasRunning -and -not $switched) {
    Write-Host 'Возвращаю JS-сервер, как был.' -ForegroundColor Yellow
    & docker @($Js + @('--profile', 'public', 'start')) | Out-Host
  }
  exit 1
}
