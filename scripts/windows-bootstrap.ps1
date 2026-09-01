[CmdletBinding()]
param(
  [switch]$Diagnostico,
  [switch]$Preparar,
  [switch]$TunelCriar
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
$BootstrapRoot = Join-Path $ProjectRoot '.bootstrap'
$NodeRoot = Join-Path $RuntimeRoot 'node'
$NodeExe = Join-Path $NodeRoot 'node.exe'
$NpmCmd = Join-Path $NodeRoot 'npm.cmd'
$LockFile = Join-Path $ProjectRoot 'package-lock.json'
$DependencyMarker = Join-Path $BootstrapRoot 'package-lock.sha256'

function Write-Step([string]$Message) {
  Write-Host "  $Message" -ForegroundColor Cyan
}

function Stop-Friendly([string]$Message) {
  throw "$Message`n  Nada foi alterado fora da pasta deste projeto."
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-WindowsArchitecture {
  $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($architecture) {
    'x64' { return 'x64' }
    'x86' { return 'x86' }
    'arm64' { return 'arm64' }
    default { Stop-Friendly "Arquitetura do Windows sem pacote oficial do Node.js: $architecture" }
  }
}

function Test-Environment {
  Write-Host ''
  Write-Host '  Diagnostico da Sala de Tela' -ForegroundColor White
  Write-Host "  Windows: $([Environment]::OSVersion.VersionString)"
  Write-Host "  Arquitetura: $([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
  Write-Host "  PowerShell: $($PSVersionTable.PSVersion)"
  Write-Host "  Pasta: $ProjectRoot"

  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Stop-Friendly 'PowerShell 5.1 ou superior e necessario.'
  }
  if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    Stop-Friendly 'Este iniciador e exclusivo para Windows 10 e 11.'
  }
  if (-not (Test-Path -LiteralPath $LockFile -PathType Leaf)) {
    Stop-Friendly 'package-lock.json nao foi encontrado. Extraia o ZIP inteiro antes de iniciar.'
  }

  $probe = Join-Path $ProjectRoot '.bootstrap-write-test.tmp'
  try {
    [IO.File]::WriteAllText($probe, 'ok')
    Remove-Item -LiteralPath $probe -Force
  } catch {
    Stop-Friendly 'A pasta nao permite gravacao. Mova o projeto para Documentos ou outra pasta sua.'
  }

  $configured = Test-Path -LiteralPath (Join-Path $ProjectRoot '.env')
  $installed = Test-Path -LiteralPath $NodeExe
  Write-Host "  Node portatil: $(if ($installed) { 'pronto' } else { 'sera baixado na primeira execucao' })"
  Write-Host "  Configuracao: $(if ($configured) { '.env encontrado' } else { 'assistente sera aberto' })"
  Write-Host '  Diagnostico concluido.' -ForegroundColor Green
}

function Get-PortableNode {
  if (Test-Path -LiteralPath $NodeExe -PathType Leaf) {
    $version = & $NodeExe --version
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(22|23|24)\.') {
      Write-Step "Node portatil $version reutilizado."
      return
    }
    Stop-Friendly "O runtime local existe, mas nao e uma versao aceita ($version). Apague somente .runtime e tente de novo."
  }

  Write-Step 'Buscando a versao LTS oficial do Node.js...'
  try {
    $releases = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
    $release = $releases | Where-Object { $_.lts -and $_.version -match '^v22\.' } | Select-Object -First 1
  } catch {
    Stop-Friendly "Nao foi possivel consultar nodejs.org: $($_.Exception.Message)"
  }
  if (-not $release) { Stop-Friendly 'Nenhuma versao Node.js 22 LTS foi encontrada no servidor oficial.' }

  $architecture = Get-WindowsArchitecture
  $archiveName = "node-$($release.version)-win-$architecture.zip"
  $baseUri = "https://nodejs.org/dist/$($release.version)"
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $archivePath = Join-Path $RuntimeRoot $archiveName
  $stagingRoot = Join-Path $RuntimeRoot 'extracting'

  Write-Step "Baixando $archiveName..."
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUri/$archiveName" -OutFile $archivePath
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUri/SHASUMS256.txt").Content
  } catch {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Stop-Friendly "Falha no download oficial do Node.js: $($_.Exception.Message)"
  }

  $expectedLine = ($checksums -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))\s*$" } | Select-Object -First 1)
  if (-not $expectedLine) {
    Remove-Item -LiteralPath $archivePath -Force
    Stop-Friendly 'O arquivo baixado nao aparece na lista oficial de hashes.'
  }
  $expectedHash = ($expectedLine.Trim() -split '\s+')[0].ToUpperInvariant()
  $actualHash = Get-Sha256 $archivePath
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $archivePath -Force
    Stop-Friendly 'A verificacao SHA-256 do Node.js falhou. O arquivo foi descartado.'
  }

  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingRoot -Force
  $extracted = Get-ChildItem -LiteralPath $stagingRoot -Directory | Select-Object -First 1
  if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $extracted.FullName 'node.exe'))) {
    Stop-Friendly 'O pacote oficial do Node.js foi extraido, mas node.exe nao foi encontrado.'
  }
  Move-Item -LiteralPath $extracted.FullName -Destination $NodeRoot
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  Remove-Item -LiteralPath $archivePath -Force
  Write-Step "Node.js $($release.version) instalado somente em .runtime."
}

function Install-Dependencies {
  $currentHash = Get-Sha256 $LockFile
  # node_modules contém binários por plataforma (por exemplo, esbuild). Só o
  # hash do lock não basta quando a mesma pasta passa por Windows e WSL/Linux.
  $fingerprint = "$currentHash|win32|$(Get-WindowsArchitecture)"
  $savedHash = if (Test-Path -LiteralPath $DependencyMarker) {
    (Get-Content -LiteralPath $DependencyMarker -Raw).Trim()
  } else { '' }
  $vite = Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'
  if ($fingerprint -eq $savedHash -and (Test-Path -LiteralPath $vite)) {
    Write-Step 'Dependencias ja estao prontas.'
    return
  }

  Write-Step 'Instalando dependencias verificadas pelo package-lock.json...'
  New-Item -ItemType Directory -Force -Path $BootstrapRoot | Out-Null
  $env:PATH = "$NodeRoot;$env:PATH"
  $env:npm_config_cache = Join-Path $ProjectRoot '.cache\npm'
  & $NpmCmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Stop-Friendly "npm ci encerrou com codigo $LASTEXITCODE." }
  [IO.File]::WriteAllText($DependencyMarker, $fingerprint, [Text.UTF8Encoding]::new($false))
}

try {
  Test-Environment
  if ($Diagnostico) { exit 0 }

  Get-PortableNode
  Install-Dependencies
  if ($TunelCriar) {
    $env:PATH = "$NodeRoot;$env:PATH"
    $env:npm_config_cache = Join-Path $ProjectRoot '.cache\npm'
    & $NpmCmd run 'tunel:criar'
    exit $LASTEXITCODE
  }
  if ($Preparar) {
    Write-Host ''
    Write-Host '  Runtime e dependencias prontos.' -ForegroundColor Green
    exit 0
  }

  Write-Host ''
  Write-Host '  Iniciando a Sala de Tela...' -ForegroundColor Green
  Write-Host '  Use Ctrl+C para encerrar servidor e tunel.' -ForegroundColor DarkGray
  Write-Host ''
  $env:PATH = "$NodeRoot;$env:PATH"
  & $NodeExe (Join-Path $ProjectRoot 'scripts\start-fast.mjs')
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "  ERRO: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  exit 1
}
