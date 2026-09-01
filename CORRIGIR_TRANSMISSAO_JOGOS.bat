@echo off
setlocal
title OTIMIZADOR DE TRANSMISSAO DE JOGOS - SALA DE TELA
color 0B

echo =========================================================================================
echo       FERRAMENTA DE CORRECAO E OTIMIZACAO PARA TRANSMISSAO DE JOGOS - ZOMBOID E RPCS3
echo =========================================================================================
echo.
echo  Esta ferramenta corrige o bloqueio de tela do Windows 10/11 - Direct Flip e MPO -
echo  que congela a imagem de jogos em OpenGL e Vulkan durante o compartilhamento de tela.
echo.
echo  ATENCAO: a correcao principal - MPO - SO ENTRA EM VIGOR DEPOIS DE REINICIAR O PC.
echo.
echo =========================================================================================
echo.

:: 1. Verificacao de Privilegios Administrativos
echo  [1/3] Verificando permissoes do sistema...
net session >nul 2>&1
if %errorlevel% neq 0 goto :sem_admin

echo  [OK] Executando com privilegios de Administrador.
goto :iniciar_otimizacao

:sem_admin
echo  [AVISO] O script nao esta rodando como Administrador.
echo          O ajuste de MPO no registro do sistema PRECISA de Admin.
echo          Feche e clique com o botao direito em "Executar como Administrador".
echo.
pause
exit /b 1

:iniciar_otimizacao
echo.
echo  [2/3] Aplicando otimizacoes no Registro do Windows para captura de jogos...
echo.

echo    - Desativando interferencia de GameDVR e captura de fundo do Windows...
reg add "HKCU\System\GameConfigStore" /v "GameDVR_Enabled" /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_FSEBehaviorMode" /t REG_DWORD /d 2 /f >nul 2>&1
reg add "HKCU\System\GameConfigStore" /v "GameDVR_HonorUserFSEBehaviorMode" /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR" /v "AppCaptureEnabled" /t REG_DWORD /d 0 /f >nul 2>&1
echo      [+] GameDVR ajustado com sucesso.

echo    - Desativando MPO - OverlayTestMode=5 no DWM...
reg add "HKLM\SOFTWARE\Microsoft\Windows\Dwm" /v "OverlayTestMode" /t REG_DWORD /d 5 /f >nul 2>&1
echo      [+] MPO desativado no registro.

:: Marca o momento em que a correcao foi aplicada, para detectar reinicio pendente.
reg add "HKCU\Software\SalaDeTela" /v "MpoAplicadoEm" /t REG_SZ /d "%date% %time%" /f >nul 2>&1

echo.
echo  [3/3] Correcoes aplicadas no registro.
echo.
echo  =======================================================================================
echo   PASSO OBRIGATORIO: REINICIE O COMPUTADOR AGORA.
echo.
echo   O Windows so aplica a desativacao do MPO - que e o que congela a imagem
echo   dos jogos OpenGL e Vulkan - depois de reiniciar. Sem reiniciar, NADA muda.
echo  =======================================================================================
echo.
set "RESP="
set /p "RESP=Deseja reiniciar o computador agora? Digite S para sim ou N para nao: "
if /i "%RESP%"=="S" goto :reiniciar

echo.
echo  Ok. Lembre-se: a correcao so vale depois do reinicio.
goto :instrucoes

:reiniciar
echo.
echo  Reiniciando em 20 segundos... Salve seus trabalhos! Para cancelar: shutdown /a
shutdown /r /t 20
goto :instrucoes

:instrucoes
echo.
echo =========================================================================================
echo  DEPOIS DE REINICIAR:
echo =========================================================================================
echo.
echo  1. PROJECT ZOMBOID:
echo     - Opcoes -^> Exibicao -^> Modo Janela ou Janela Sem Bordas.
echo.
echo  2. RPCS3 - Emulador PS3:
echo     - Configuration -^> GPU -^> Exclusive Fullscreen Mode: Disabled.
echo.
echo  3. PARA TRANSMITIR:
echo     - Use o TRANSMITIR_SEM_TRAVAR.bat para abrir o navegador otimizado.
echo     - Nele, compartilhe a Tela Inteira com o jogo em janela sem bordas,
echo       ou a Janela do jogo diretamente.
echo.
echo =========================================================================================
echo  Processo concluido. Pressione qualquer tecla para fechar.
echo =========================================================================================
echo.
pause
