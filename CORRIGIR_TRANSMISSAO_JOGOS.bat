@echo off
setlocal EnableDelayedExpansion
title OTIMIZADOR DE TRANSMISSAO DE JOGOS - SALA DE TELA
color 0B

echo =========================================================================================
echo       FERRAMENTA DE CORRECAO E OTIMIZACAO PARA TRANSMISSAO DE JOGOS - ZOMBOID E RPCS3
echo =========================================================================================
echo.
echo  Esta ferramenta corrige o bloqueio de tela do Windows 10/11 - Direct Flip e MPO
echo  que congela a imagem de jogos em OpenGL e Vulkan durante o compartilhamento de tela.
echo.
echo =========================================================================================
echo.

:: 1. Verificacao de Privilegios Administrativos
echo  [1/4] Verificando permissoes do sistema...
net session >nul 2>&1
if %errorlevel% neq 0 goto :sem_admin

echo  [OK] Executando com privilegios de Administrador.
goto :iniciar_otimizacao

:sem_admin
echo  [AVISO] O script nao esta rodando como Administrador.
echo          Alguns ajustes de registro do sistema precisam de Admin.
echo          Recomendado: Fechar e clicar com botao direito em "Executar como Administrador".
echo.

:iniciar_otimizacao
echo.
echo  [2/4] Aplicando otimizacoes no Registro do Windows para captura de jogos...
echo.

echo    - Desativando interferencia de GameDVR e captura de fundo do Windows...
reg add "HKCU\System\GameConfigStore" /v "GameDVR_Enabled" /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_FSEBehaviorMode" /t REG_DWORD /d 2 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_HonorUserFSEBehaviorMode" /t REG_DWORD /d 1 /f >nul 2>&1
echo      [+] GameDVR ajustado com sucesso.

echo    - Ajustando modo de apresentacao de janelas DWM e Direct Flip...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR" /v "AppCaptureEnabled" /t REG_DWORD /d 0 /f >nul 2>&1
echo      [+] Modo de apresentacao DWM ajustado.

echo    - Otimizando MPO OverlayTestMode no DWM...
reg add "HKLM\SOFTWARE\Microsoft\Windows\Dwm" /v "OverlayTestMode" /t REG_DWORD /d 5 /f >nul 2>&1
echo      [+] Registro do DWM e MPO otimizado no HKLM.

echo.
echo  [3/4] Localizando navegador para aplicar flags avancadas de transmissao...
echo.

set "FLAGS=--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=ThrottleRepeatedNoDamageFrames,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --enable-gpu-rasterization --ignore-gpu-blocklist"

set "BROWSER_PATH="
set "BROWSER_NAME="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome 64-bit"
    goto :abrir_navegador
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome 32-bit"
    goto :abrir_navegador
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    set "BROWSER_NAME=Google Chrome Local"
    goto :abrir_navegador
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge"
    goto :abrir_navegador
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    set "BROWSER_NAME=Microsoft Edge 64-bit"
    goto :abrir_navegador
)
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_PATH=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "BROWSER_NAME=Brave Browser"
    goto :abrir_navegador
)

echo    [AVISO] Navegador padrao nao localizado automaticamente nas pastas padrao.
goto :instrucoes

:abrir_navegador
echo    Navegador encontrado: !BROWSER_NAME!
echo    Caminho: !BROWSER_PATH!
echo.
echo    Flags aplicadas:
echo    * --disable-backgrounding-occluded-windows
echo    * --disable-features=ThrottleRepeatedNoDamageFrames
echo    * --disable-renderer-backgrounding
echo.
echo    Iniciando navegador com todas as otimizacoes ativas...
start "" "!BROWSER_PATH!" %FLAGS%
echo    [OK] Navegador aberto com sucesso!

:instrucoes
echo.
echo =========================================================================================
echo  [4/4] INSTRUCOES FINAIS PARA OS SEUS JOGOS:
echo =========================================================================================
echo.
echo  1. PROJECT ZOMBOID:
echo     - Abra o jogo e va em Opcoes -^> Exibicao.
echo     - Configure para Modo Janela ou Janela Sem Bordas.
echo.
echo  2. RPCS3 (Emulador PS3):
echo     - Va em Configuration -^> GPU.
echo     - Em Exclusive Fullscreen Mode, selecione Disabled.
echo.
echo  3. NO SELETOR DE COMPARTILHAMENTO:
echo     - Selecione a aba Janela e clique direto no Zomboid ou RPCS3,
echo       OU escolha Tela Inteira com o jogo em modo janela sem bordas.
echo.
echo =========================================================================================
echo  Processo concluido com sucesso! Pressione qualquer tecla para fechar.
echo =========================================================================================
echo.
pause
