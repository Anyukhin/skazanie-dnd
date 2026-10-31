@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Останавливаю сервер Сказания и публичный туннель...
rem Оба сервера: Rust (compose.rust.yaml) и JS (compose.yaml). Хранилища
rem остаются — том skazanie-rust_storage и ./storage.
docker compose -f compose.rust.yaml --profile public down --remove-orphans
if errorlevel 1 set "STOP_FAILED=1"
docker compose --profile public down --remove-orphans
if errorlevel 1 set "STOP_FAILED=1"
if defined STOP_FAILED (
  echo.
  echo Не удалось остановить контейнеры. Убедитесь, что Docker Desktop запущен.
) else (
  echo.
  echo Сервер остановлен.
)
pause
