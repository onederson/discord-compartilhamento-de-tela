@echo off
setlocal
title CORRECAO DE TRANSMISSAO DE JOGOS - SALA DE TELA
color 0B

echo =========================================================================================
echo         CORRECAO DE TRANSMISSAO DE JOGOS OPENGL E VULKAN - ZOMBOID, RPCS3 E OUTROS
echo =========================================================================================
echo.
echo  Sintoma: a imagem congela para quem assiste assim que voce clica no jogo, e volta
echo  a funcionar quando voce da Alt+Tab. Acontece com jogos OpenGL e Vulkan.
echo.
echo  Causa: o driver de video entrega esses jogos direto ao monitor por um caminho que a
echo  captura de tela do Windows nao enxerga. A correcao principal e no driver NVIDIA.
echo.
echo =========================================================================================
echo.

:: 1. Verificacao de Privilegios Administrativos
echo  [1/3] Verificando permissoes do sistema...
net session >nul 2>&1
if %errorlevel% neq 0 goto :sem_admin
echo  [OK] Executando com privilegios de Administrador.
goto :registro

:sem_admin
echo  [AVISO] O script nao esta rodando como Administrador.
echo          Os ajustes de registro precisam de Admin.
echo          Feche e clique com o botao direito em "Executar como Administrador".
echo.
pause
exit /b 1

:registro
echo.
echo  [2/3] Aplicando ajustes complementares no Registro do Windows...
reg add "HKCU\System\GameConfigStore" /v "GameDVR_Enabled" /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_FSEBehaviorMode" /t REG_DWORD /d 2 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_HonorUserFSEBehaviorMode" /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR" /v "AppCaptureEnabled" /t REG_DWORD /d 0 /f >nul 2>&1
echo      [+] GameDVR desativado.
reg add "HKLM\SOFTWARE\Microsoft\Windows\Dwm" /v "OverlayTestMode" /t REG_DWORD /d 5 /f >nul 2>&1
echo      [+] MPO desativado no DWM - passa a valer no proximo reinicio.
reg add "HKCU\Software\SalaDeTela" /v "MpoAplicadoEm" /t REG_SZ /d "%date% %time%" /f >nul 2>&1

echo.
echo  [3/3] Detectando placa de video...
set "GPU_NVIDIA="
powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Where-Object Name -match NVIDIA | Select-Object -ExpandProperty Name -First 1" > "%TEMP%\saladetela_gpu.txt" 2>nul
set /p GPU_NVIDIA=<"%TEMP%\saladetela_gpu.txt"
del "%TEMP%\saladetela_gpu.txt" >nul 2>&1

if not defined GPU_NVIDIA goto :outras_placas

echo      [+] Encontrada: %GPU_NVIDIA%
echo.
echo =========================================================================================
echo   CORRECAO PRINCIPAL - FACA ESTE PASSO NO PAINEL DE CONTROLE NVIDIA:
echo =========================================================================================
echo.
echo   1. Botao direito na area de trabalho -^> Painel de Controle NVIDIA.
echo      Se nao aparecer, abra pelo aplicativo NVIDIA App -^> Graficos.
echo.
echo   2. Gerenciar configuracoes 3D -^> aba Configuracoes globais.
echo.
echo   3. Procure na lista: "Metodo de apresentacao Vulkan/OpenGL"
echo      em ingles: "Vulkan/OpenGL present method".
echo.
echo   4. Mude de "Automatico" para:
echo.
echo         "Preferir em camadas no DXGI Swapchain"
echo         em ingles: "Prefer layered on DXGI Swapchain"
echo.
echo   5. Clique em Aplicar. Feche e reabra o jogo. Pronto.
echo.
echo   Dica: se preferir nao mudar globalmente, faca o mesmo na aba
echo   "Configuracoes de programa" escolhendo so o Zomboid e o RPCS3.
echo.
goto :reinicio

:outras_placas
echo      [i] Nenhuma placa NVIDIA detectada. Os ajustes de registro acima ja cobrem
echo          o caso mais comum em AMD e Intel. Se ainda travar, no jogo use
echo          Janela sem Bordas e desative "Otimizacoes para jogos em janela" no Windows.
echo.

:reinicio
echo =========================================================================================
echo   Os ajustes de registro so valem apos reiniciar o computador. A correcao NVIDIA
echo   vale imediatamente ao reabrir o jogo.
echo =========================================================================================
echo.
set "RESP="
set /p "RESP=Deseja reiniciar o computador agora? Digite S para sim ou N para nao: "
if /i "%RESP%"=="S" goto :reiniciar
echo.
echo  Ok. Lembre-se de reiniciar mais tarde para os ajustes de registro valerem.
goto :fim

:reiniciar
echo.
echo  Reiniciando em 20 segundos... Salve seus trabalhos! Para cancelar: shutdown /a
shutdown /r /t 20

:fim
echo.
echo =========================================================================================
echo  COMO TRANSMITIR DEPOIS:
echo    - Zomboid: Opcoes -^> Exibicao -^> Janela sem Bordas.
echo    - RPCS3: Configuration -^> GPU -^> Exclusive Fullscreen Mode: Disabled.
echo    - Compartilhe a Tela Inteira ou a Janela do jogo pelo seu navegador normal.
echo    - Se ainda travar, abra o navegador pelo TRANSMITIR_SEM_TRAVAR.bat.
echo =========================================================================================
echo.
pause
