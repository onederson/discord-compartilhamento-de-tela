@echo off
setlocal
title Navegador Otimizado para Transmissao de Jogos
color 0B

echo ==========================================================================
echo    NAVEGADOR OTIMIZADO PARA TRANSMISSAO - MODO JOGOS
echo ==========================================================================
echo.
echo  Este script abre um navegador SEPARADO do seu Chrome normal, com perfil
echo  proprio. Isso GARANTE que as flags anti-congelamento sejam aplicadas
echo  mesmo que o seu Chrome do dia a dia ja esteja aberto.
echo.
echo  IMPORTANTE: se voce rodou o CORRIGIR_TRANSMISSAO_JOGOS.bat e ainda nao
echo  reiniciou o computador, REINICIE ANTES. A correcao de MPO do Windows
echo  so passa a valer depois de reiniciar.
echo.
echo  Escolha o motor de captura de tela:
echo.
echo    [1] Moderno  - Windows Graphics Capture / WGC - recomendado
echo    [2] Classico - DXGI/GDI - use se o modo 1 continuar travando
echo.
set "MODO="
set /p "MODO=Digite 1 ou 2 e pressione Enter - padrao 1: "
if "%MODO%"=="2" goto :modo_classico

set "FLAGS=--enable-features=AllowWgcScreenCapturer,AllowWgcWindowCapturer --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleRepeatedNoDamageFrames"
echo.
echo  Modo selecionado: 1 - Moderno WGC
goto :perguntar_link

:modo_classico
set "FLAGS=--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleRepeatedNoDamageFrames,AllowWgcScreenCapturer,AllowWgcWindowCapturer"
echo.
echo  Modo selecionado: 2 - Classico DXGI/GDI

:perguntar_link
set "FLAGS=%FLAGS% --no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required --disable-infobars"
set "PERFIL=%LocalAppData%\SalaDeTela\NavegadorJogos"
echo.
echo  Cole o link de transmissao - o que termina em /share.html?t=...
echo  Se deixar vazio, o navegador abre em branco e voce cola o link nele.
echo.
set "LINK="
set /p "LINK=Link: "
if "%LINK%"=="" set "LINK=about:blank"

echo.
echo  Procurando navegador compativel...

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome"
    goto :abrir
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome"
    goto :abrir
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome"
    goto :abrir
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge"
    goto :abrir
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge"
    goto :abrir
)
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_PATH=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "BROWSER_NAME=Brave"
    goto :abrir
)
if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_PATH=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "BROWSER_NAME=Brave"
    goto :abrir
)

echo  [ERRO] Nenhum navegador Chromium foi encontrado nas pastas padrao.
echo         Instale o Google Chrome e rode este script de novo.
pause
exit /b 1

:abrir
echo  Navegador: %BROWSER_NAME%
echo  Perfil dedicado: %PERFIL%
echo.
echo  Abrindo com as flags:
echo  %FLAGS%
echo.
start "" "%BROWSER_PATH%" --user-data-dir="%PERFIL%" %FLAGS% "%LINK%"
echo  [OK] Navegador aberto!
echo.
echo  DICA DE VERIFICACAO: nesse navegador, abra chrome://version e confira
echo  se a "Linha de comando" mostra as flags acima. Se mostrar, esta ativo.
echo.
echo  Use ESTE navegador para abrir o link de transmissao e compartilhar.
echo.
pause
exit /b 0
