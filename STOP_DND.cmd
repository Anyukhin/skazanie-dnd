@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Останавливаю сервер Сказания и публичный туннель...
docker compose --profile public down --remove-orphans
if errorlevel 1 (
  echo.
  echo Не удалось остановить контейнеры. Убедитесь, что Docker Desktop запущен.
) else (
  echo.
  echo Сервер остановлен.
)
pause
