@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Состояние сервера Сказания:
echo.
docker compose --profile public ps
echo.
powershell.exe -NoLogo -NoProfile -Command "$source='storage\generated\.tunnel\PUBLIC_LINK.txt'; $target='PUBLIC_LINK.txt'; $value=if(Test-Path -LiteralPath $source){[string](Get-Content -LiteralPath $source -Raw -Encoding UTF8)}else{''}; $value=$value.Trim(); $uri=$null; $valid=[uri]::TryCreate($value,[System.UriKind]::Absolute,[ref]$uri) -and $uri.Scheme -eq 'https' -and $uri.Host -match '^[a-z0-9][a-z0-9.-]*\.(free\.pinggy\.net|pinggy-free\.link|pinggy\.link)$'; if($valid){Set-Content -LiteralPath $target -Value $value -Encoding UTF8; Write-Host 'Текущая публичная HTTPS-ссылка:' -ForegroundColor Green; Write-Host $value -ForegroundColor Green}else{Set-Content -LiteralPath $target -Value '' -NoNewline -Encoding UTF8; Write-Host 'Публичная ссылка пока не получена.' -ForegroundColor Yellow; Write-Host 'Для диагностики: docker compose logs tunnel' -ForegroundColor DarkGray}"
echo.
pause
