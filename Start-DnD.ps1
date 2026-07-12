$ErrorActionPreference = 'Stop'

$ProjectRoot = if ($env:DND_PROJECT_ROOT) {
  $env:DND_PROJECT_ROOT.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
} else {
  (Get-Location).Path
}
Set-Location -LiteralPath $ProjectRoot

$TunnelStateDirectory = Join-Path $ProjectRoot 'storage\generated\.tunnel'
$TunnelStatePath = Join-Path $TunnelStateDirectory 'PUBLIC_LINK.txt'
$PublicLinkPath = Join-Path $ProjectRoot 'PUBLIC_LINK.txt'

function Write-Step([string]$Message) {
  Write-Host $Message -ForegroundColor Cyan
}

function Test-DockerReady {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    docker info *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Invoke-Docker([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & docker @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    throw "Docker завершил команду с кодом $exitCode."
  }
}

function Read-EnvValue([string]$Name) {
  if (-not (Test-Path -LiteralPath '.env')) { return '' }
  $line = Get-Content -LiteralPath '.env' -Encoding UTF8 |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

function Add-EnvValue([string]$Name, [string]$Value) {
  Add-Content -LiteralPath '.env' -Value ([Environment]::NewLine + "$Name=$Value") -Encoding UTF8
}

function Convert-ToPublicUrl([string]$Value) {
  if (-not $Value) { return '' }
  $candidate = $Value.Trim().Trim('"').Trim("'")
  if ($candidate -notmatch '^https?://') { $candidate = "https://$candidate" }
  $uri = $null
  if (-not [uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri)) { return '' }
  $hostName = $uri.Host.ToLowerInvariant()
  $allowed = $hostName.EndsWith('.free.pinggy.net') -or
    $hostName.EndsWith('.pinggy-free.link') -or
    $hostName.EndsWith('.pinggy.link')
  if (-not $allowed) { return '' }
  return "https://$($uri.Authority)"
}

function Get-TunnelPublicUrl {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $logs = docker compose logs --no-color --tail 120 tunnel 2>$null | Out-String
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  $matches = [regex]::Matches(
    $logs,
    'https://[a-z0-9][a-z0-9.-]*\.(?:free\.pinggy\.net|pinggy-free\.link|pinggy\.link)',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if ($matches.Count -gt 0) {
    return Convert-ToPublicUrl $matches[$matches.Count - 1].Value
  }

  if (Test-Path -LiteralPath $TunnelStatePath) {
    return Convert-ToPublicUrl (Get-Content -LiteralPath $TunnelStatePath -Raw -Encoding UTF8)
  }
  return ''
}

function Wait-ForDocker([int]$TimeoutSeconds = 180) {
  if (Test-DockerReady) { return $true }

  $dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw 'Docker Desktop не найден. Установите Docker Desktop один раз, после этого START_DND.cmd будет запускать всё автоматически.'
  }

  Write-Step 'Docker выключен — запускаю Docker Desktop автоматически...'
  Start-Process -FilePath $dockerDesktop

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastNotice = -1
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-DockerReady) {
      Write-Host 'Docker Desktop готов.' -ForegroundColor Green
      return $true
    }
    $elapsed = $TimeoutSeconds - [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
    $notice = [Math]::Floor($elapsed / 10)
    if ($notice -ne $lastNotice) {
      Write-Host "Ожидаю Docker Desktop... $elapsed сек." -ForegroundColor DarkGray
      $lastNotice = $notice
    }
    Start-Sleep -Seconds 2
  }
  throw 'Docker Desktop не успел запуститься за 3 минуты. Перезапустите компьютер и снова нажмите START_DND.cmd.'
}

function Wait-ForServer([int]$TimeoutSeconds = 150) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/health' -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

try {
  Write-Host '============================================' -ForegroundColor DarkYellow
  Write-Host '       СКАЗАНИЕ · ЗАПУСК В ОДИН КЛИК       ' -ForegroundColor Yellow
  Write-Host '============================================' -ForegroundColor DarkYellow

  if (-not (Test-Path -LiteralPath '.env')) {
    if (Test-Path -LiteralPath '.env.example') {
      Copy-Item -LiteralPath '.env.example' -Destination '.env'
      Write-Host 'Создан файл настроек .env.' -ForegroundColor Green
    } else {
      New-Item -ItemType File -Path '.env' -Force | Out-Null
    }
  }

  $adminSetupToken = Read-EnvValue 'ADMIN_SETUP_TOKEN'
  if (-not $adminSetupToken) {
    $adminSetupToken = [guid]::NewGuid().ToString('N')
    Add-EnvValue 'ADMIN_SETUP_TOKEN' $adminSetupToken
  }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Команда docker не найдена. Установите Docker Desktop один раз: https://www.docker.com/products/docker-desktop/'
  }

  [void](Wait-ForDocker)

  New-Item -ItemType Directory -Path $TunnelStateDirectory -Force | Out-Null
  Set-Content -LiteralPath $TunnelStatePath -Value '' -NoNewline -Encoding UTF8
  Set-Content -LiteralPath $PublicLinkPath -Value '' -NoNewline -Encoding UTF8

  Write-Step 'Собираю и запускаю сервер и публичную ссылку...'
  Invoke-Docker @('compose', '--profile', 'public', 'up', '-d', '--build', '--remove-orphans')

  Write-Step 'Ожидаю готовность игрового сервера...'
  if (-not (Wait-ForServer)) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    docker compose logs --no-color --tail 80 skazanie
    $ErrorActionPreference = $previousPreference
    throw 'Сервер был запущен, но не ответил на проверку здоровья.'
  }

  $publicUrl = ''
  for ($attempt = 0; $attempt -lt 60 -and -not $publicUrl; $attempt += 1) {
    $publicUrl = Get-TunnelPublicUrl
    if (-not $publicUrl) { Start-Sleep -Seconds 2 }
  }

  $localUrl = "http://localhost:8787/?setup=$adminSetupToken"
  Write-Host ''
  Write-Host 'Сервер полностью запущен.' -ForegroundColor Green
  Write-Host 'Локальный адрес: http://localhost:8787' -ForegroundColor Green

  if ($publicUrl) {
    Set-Content -LiteralPath $PublicLinkPath -Value $publicUrl -Encoding UTF8
    try { Set-Clipboard -Value $publicUrl -ErrorAction Stop } catch {}
    Write-Host "Ссылка для друзей: $publicUrl" -ForegroundColor Green
    Write-Host 'Ссылка сохранена в PUBLIC_LINK.txt и скопирована в буфер обмена.' -ForegroundColor DarkGray
  } else {
    Write-Host 'Сервер работает локально, но Pinggy пока не выдал публичную ссылку.' -ForegroundColor Yellow
    Write-Host 'Её можно проверить позже через STATUS_DND.cmd.' -ForegroundColor DarkGray
  }

  if ($env:DND_NO_BROWSER -ne '1') {
    Start-Process $localUrl
  }

  Write-Host ''
  Write-Host 'Больше ничего запускать не нужно. Docker и сервер продолжат работать.' -ForegroundColor Cyan
  Write-Host 'Для остановки используйте STOP_DND.cmd.' -ForegroundColor DarkGray
  if ($env:DND_AUTOCLOSE -ne '1') {
    Write-Host 'Нажмите Enter, чтобы закрыть это окно.' -ForegroundColor DarkGray
    [void](Read-Host)
  }
  exit 0
} catch {
  Write-Host ''
  Write-Host 'Не удалось запустить игру:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'Окно останется открытым. Текст выше можно прислать для диагностики.' -ForegroundColor Yellow
  exit 1
}
