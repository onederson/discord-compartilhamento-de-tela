@echo off
setlocal
cd /d "%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERRO: o Windows PowerShell nao foi encontrado.
  echo Este iniciador precisa do PowerShell incluido no Windows 10 e 11.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-bootstrap.ps1" %*
set "SALA_EXIT=%ERRORLEVEL%"

if not "%SALA_EXIT%"=="0" (
  echo.
  echo A Sala de Tela encerrou com erro %SALA_EXIT%.
  echo Leia a mensagem acima. O diagnostico tambem pode ser executado com:
  echo   INICIAR.bat -Diagnostico
  echo.
  pause
)

exit /b %SALA_EXIT%
