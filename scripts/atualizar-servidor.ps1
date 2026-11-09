# Atualiza o servidor em produção (Windows + pm2) a partir do GitHub.
#
# Uso, na pasta do projeto:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\atualizar-servidor.ps1
#   ... -Branch main          # outra branch (padrão: dev)
#   ... -Forcar               # refaz mesmo sem commit novo
#
# O que faz: busca a branch, para o pm2, troca os arquivos, reinstala as
# dependências de produção só se o package-lock mudou, sobe de novo e confere
# o /api/health. Se o servidor não responder, volta sozinho ao commit anterior
# e sobe de novo — um deploy ruim nunca deixa a tela fora do ar.
#
# Nunca toca em .env, .logs nem .dados: são ignorados pelo git, e o checkout
# só mexe em arquivos versionados. Encadear isto em cmd pelo SSH falhou duas
# vezes (pm2 e npm são .cmd e derrubam o resto da linha); por isso um script.

param(
  [string]$Branch = 'dev',
  [string]$App = 'discord-tela',
  [switch]$Forcar
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = 'C:\Tools\mingit\cmd\git.exe' }

function Rodar([string]$exe, [string[]]$argumentos) {
  & $exe @argumentos
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argumentos -join ' ') falhou (código $LASTEXITCODE)" }
}

function Porta {
  $linha = Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PORT=\d+' } | Select-Object -First 1
  if ($linha) { return ($linha -split '=', 2)[1].Trim() }
  return '3001'
}

function Saudavel {
  $url = "http://127.0.0.1:$(Porta)/api/health"
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-RestMethod -Uri $url -TimeoutSec 3
      if ($r.ok) { return $true }
    } catch { }
  }
  return $false
}

function Subir([bool]$reinstalar) {
  Rodar $git @('clean', '-fdq', 'client/dist')
  if ($reinstalar) { Rodar 'npm.cmd' @('ci', '--omit=dev', '--no-audit', '--no-fund') }
  Rodar 'pm2.cmd' @('restart', $App, '--update-env')
}

$antes = (& $git rev-parse HEAD).Trim()
Rodar $git @('fetch', '-q', 'origin', $Branch)
$alvo = (& $git rev-parse "origin/$Branch").Trim()

if ($antes -eq $alvo -and -not $Forcar) {
  Write-Output "Já está em $($alvo.Substring(0, 7)). Nada a fazer."
  exit 0
}

$lockMudou = [bool](& $git diff --name-only $antes $alvo -- package-lock.json)
Write-Output "Atualizando $($antes.Substring(0, 7)) -> $($alvo.Substring(0, 7)) (dependências: $(if ($lockMudou) { 'reinstalar' } else { 'iguais' }))"

Rodar 'pm2.cmd' @('stop', $App)
try {
  Rodar $git @('checkout', '-q', '-f', '-B', $Branch, "origin/$Branch")
  Subir $lockMudou
  if (-not (Saudavel)) { throw 'o servidor não respondeu ao /api/health em 30s' }
  Write-Output "OK: no ar em $($alvo.Substring(0, 7))."
} catch {
  Write-Output "FALHOU: $($_.Exception.Message). Voltando para $($antes.Substring(0, 7))..."
  & $git checkout -q -f -B $Branch $antes
  Subir $lockMudou
  if (Saudavel) { Write-Output 'Versão anterior restaurada e no ar.' } else { Write-Output 'ATENÇÃO: a versão anterior também não respondeu. Veja: pm2 logs' }
  exit 1
}
