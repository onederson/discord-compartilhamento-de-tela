$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'audio-loopback.cpp'
$output = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $output | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw 'Visual Studio Build Tools não encontrado.'
}

$install = & $vswhere -latest -version '[17.0,18.0)' -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $install) {
  throw 'Componente C++ x64 do Visual Studio Build Tools não encontrado.'
}

$devShell = Join-Path $install 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $install -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'

cl.exe /nologo /std:c++20 /EHsc /O2 /MT /W4 /DUNICODE /D_UNICODE $source /Fo:"$output\audio-loopback.obj" /Fe:"$output\audio-loopback.exe" /link windowsapp.lib ole32.lib user32.lib avrt.lib
if ($LASTEXITCODE -ne 0) { throw "cl.exe terminou com código $LASTEXITCODE" }
Remove-Item -LiteralPath (Join-Path $output 'audio-loopback.obj') -Force -ErrorAction SilentlyContinue
