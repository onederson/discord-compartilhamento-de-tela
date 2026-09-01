@echo off
setlocal
title Iniciar Navegador Otimizado para Transmissao

echo ========================================================
echo   Iniciando Navegador Otimizado (Anti-Congelamento)
echo ========================================================
echo.
echo Este script abre o navegador com as flags de segundo plano
echo desativadas para que jogos (Zomboid, RPCS3, etc.) nao congelem
echo a transmissao quando entrarem em tela cheia/foco.
echo.

set "FLAGS=--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding"

:: 1. Tenta abrir o Google Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    echo Abrindo Google Chrome...
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" %FLAGS%
    goto :sucesso
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    echo Abrindo Google Chrome...
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" %FLAGS%
    goto :sucesso
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    echo Abrindo Google Chrome...
    start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" %FLAGS%
    goto :sucesso
)

:: 2. Tenta abrir o Microsoft Edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    echo Abrindo Microsoft Edge...
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" %FLAGS%
    goto :sucesso
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    echo Abrindo Microsoft Edge...
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" %FLAGS%
    goto :sucesso
)

:: 3. Tenta abrir o Brave
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    echo Abrindo Brave Browser...
    start "" "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" %FLAGS%
    goto :sucesso
)
if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    echo Abrindo Brave Browser...
    start "" "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" %FLAGS%
    goto :sucesso
)

echo Nenhum navegador Chromium compativel foi localizado automaticamente.
echo Abra o seu navegador e acesse chrome://flags para desativar "Calculate window occlusion on Windows".
pause
exit /b 1

:sucesso
echo Navegador aberto com sucesso com as otimizacoes ativas!
timeout /t 3 >nul
exit /b 0
