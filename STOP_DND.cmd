@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Останавливаю сервер Сказания и публичный туннель...
rem Сервер игры — Rust (compose.rust.yaml). Хранилища остаются — том
rem skazanie-rust_storage и ./storage. Прежний JS-контейнер (проект из
rem archive/js-server/compose.yaml) гасится заодно, если ещё жив; его ошибка
rem остановку не срывает.
docker compose -f compose.rust.yaml --profile public down --remove-orphans
if errorlevel 1 set "STOP_FAILED=1"
docker compose -f archive/js-server/compose.yaml --project-directory . --profile public down --remove-orphans >nul 2>&1
if defined STOP_FAILED (
  echo.
  echo Не удалось остановить контейнеры. Убедитесь, что Docker Desktop запущен.
) else (
  echo.
  echo Сервер остановлен.
)
pause
