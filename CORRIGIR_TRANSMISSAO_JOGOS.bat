@echo off
setlocal EnableDelayedExpansion
title OTIMIZADOR DE TRANSMISSAO DE JOGOS - SALA DE TELA
color 0B
mode con: cols=95 lines=38

echo =========================================================================================
echo       FERRAMENTA DE CORRECAO E OTIMIZACAO PARA TRANSMISSAO DE JOGOS (ZOMBOID / RPCS3)
echo =========================================================================================
echo.
echo  Esta ferramenta corrige o bloqueio de tela do Windows 10/11 (Direct Flip / MPO)
echo  que congela a imagem de jogos em OpenGL e Vulkan durante o compartilhamento de tela.
echo.
echo =========================================================================================
echo.

:: 1. Verificacao de Privilegios Administrativos
echo  [1/4] Verificando permissoes do sistema...
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [AVISO] O script nao esta rodando como Administrador.
    echo          Alguns ajustes de registro do sistema (MPO) necessitam de Admin.
    echo          Recomendado: Fechar e clicar com botao direito -> "Executar como Administrador".
    echo.
) else (
    echo  [OK] Executando com privilegios de Administrador.
    echo.
)

:: 2. Ajustando Registro do Windows (DirectX / GameDVR / MPO)
echo  [2/4] Aplicando otimizacoes no Registro do Windows para captura de jogos...
echo.

echo    - Desativando interferencia de GameDVR / Captura em segundo plano do Windows...
reg add "HKCU\System\GameConfigStore" /v "GameDVR_Enabled" /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_FSEBehaviorMode" /t REG_DWORD /d 2 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_HonorUserFSEBehaviorMode" /t REG_DWORD /d 1 /f >nul 2>&1
echo      [+] GameDVR ajustado com sucesso.

echo    - Ajustando modo de apresentacao de janelas (DWM / Direct Flip)...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR" /v "AppCaptureEnabled" /t REG_DWORD /d 0 /f >nul 2>&1
echo      [+] Modo de apresentacao DWM ajustado.

net session >nul 2>&1
if %errorlevel% == 0 (
    echo    - Desativando MPO (Multi-Plane Overlay) que trava captura de OpenGL/Vulkan...
    reg add "HKLM\SOFTWARE\Microsoft\Windows\Dwm" /v "OverlayTestMode" /t REG_DWORD /d 5 /f >nul 2>&1
    echo      [+] Registro do DWM/MPO otimizado no HKLM.
)

echo.
echo  [3/4] Localizando navegador para aplicar flags avancadas de transmissao...
echo.

set "FLAGS=--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=ThrottleRepeatedNoDamageFrames,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --enable-gpu-rasterization --ignore-gpu-blocklist"

set "BROWSER_PATH="
set "BROWSER_NAME="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome (64-bit)"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome (32-bit)"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome (Local)"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge (64-bit)"
) else if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_PATH=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "BROWSER_NAME=Brave Browser"
)

if defined BROWSER_PATH (
    echo    Navegador encontrado: !BROWSER_NAME!
    echo    Caminho: !BROWSER_PATH!
    echo.
    echo    Flags aplicadas:
    echo    * --disable-backgrounding-occluded-windows (Impede o navegador de dormir)
    echo    * --disable-features=ThrottleRepeatedNoDamageFrames (Nao corta FPS de jogos)
    echo    * --disable-renderer-backgrounding (Mantem o encoder ativo em 60 FPS)
    echo.
    echo    Iniciando navegador com todas as otimizacoes ativas...
    start "" "!BROWSER_PATH!" %FLAGS%
    echo    [OK] Navegador aberto!
) else (
    echo    [AVISO] Navegador padrao nao localizado automaticamente nas pastas padrao.
)

echo.
echo =========================================================================================
echo  [4/4] INSTRUCOES FINAIS PARA OS SEUS JOGOS (MUITO IMPORTANTE):
echo =========================================================================================
echo.
echo  1. PROJECT ZOMBOID:
echo     - Abra o jogo e va em "Opcoes" -^> "Exibicao".
echo     - Configure para "Modo Janela" ou "Janela Sem Bordas" (Borderless).
echo.
echo  2. RPCS3 (Emulador PS3):
echo     - Va em "Configuration" -^> "GPU".
echo     - Em "Exclusive Fullscreen Mode", selecione "Disabled".
echo.
echo  3. NO SELETOR DE COMPARTILHAMENTO:
echo     - Selecione a aba "Janela" e clique direto no Zomboid ou RPCS3,
echo       OU escolha "Tela Inteira" com o jogo em modo janela sem bordas.
echo.
echo =========================================================================================
echo  Processo concluido! Esta janela permanecera aberta para sua leitura.
echo =========================================================================================
echo.
pause
