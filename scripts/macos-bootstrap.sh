#!/bin/sh
# Bootstrap portátil da Sala de Tela para macOS Intel e Apple Silicon.
# Não usa Homebrew, não pede administrador e mantém Node/npm dentro do projeto.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
BOOTSTRAP_ROOT="$PROJECT_ROOT/.bootstrap"
LOCK_FILE="$PROJECT_ROOT/package-lock.json"
DEPENDENCY_MARKER="$BOOTSTRAP_ROOT/package-lock.sha256"
NODE_DIST_BASE=https://nodejs.org/dist/latest-v22.x
MODE=start

if [ -t 1 ]; then
  BLUE='\033[36m'
  GREEN='\033[32m'
  RED='\033[31m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  BLUE=''
  GREEN=''
  RED=''
  DIM=''
  RESET=''
fi

step() { printf '  %b%s%b\n' "$BLUE" "$1" "$RESET"; }
note() { printf '  %b%s%b\n' "$DIM" "$1" "$RESET"; }
die() {
  printf '\n  %bERRO: %s%b\n' "$RED" "$1" "$RESET" >&2
  printf '  Nada foi instalado no sistema; runtime e cache ficam somente nesta pasta.\n\n' >&2
  exit 1
}

usage() {
  cat <<'EOF'
Uso:
  ./INICIAR.command                 prepara e inicia a Sala de Tela
  ./INICIAR.command --diagnostico  verifica o ambiente sem instalar nada
  ./INICIAR.command --preparar     instala runtime/dependências sem iniciar
  ./INICIAR.command --tunel-criar  configura um túnel de endereço fixo
EOF
}

for argument in "$@"; do
  case "$argument" in
    --diagnostico|-Diagnostico) MODE=diagnostic ;;
    --preparar|-Preparar) MODE=prepare ;;
    --tunel-criar) MODE=tunnel ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Opção desconhecida: $argument" ;;
  esac
done

[ "$(uname -s 2>/dev/null || true)" = Darwin ] || die 'Este iniciador é exclusivo para macOS. No Linux use INICIAR.sh; no Windows, INICIAR.bat.'
[ -f "$LOCK_FILE" ] || die 'package-lock.json não foi encontrado. Extraia o ZIP inteiro antes de iniciar.'

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64 ;;
  *) die "Arquitetura sem pacote oficial do Node.js 22 para macOS: $machine" ;;
esac

NODE_ROOT="$RUNTIME_ROOT/node-darwin-$NODE_ARCH"
NODE_BIN="$NODE_ROOT/bin/node"
NPM_BIN="$NODE_ROOT/bin/npm"

cd "$PROJECT_ROOT"

probe="$PROJECT_ROOT/.bootstrap-write-test.tmp"
if ! (umask 077 && : > "$probe") 2>/dev/null; then
  die 'A pasta não permite gravação. Mova o projeto para Downloads ou Documentos e extraia novamente.'
fi
rm -f "$probe"

node_version='não instalado'
if [ -x "$NODE_BIN" ]; then
  node_version=$($NODE_BIN --version 2>/dev/null || true)
fi

printf '\n  Sala de Tela · diagnóstico macOS\n'
printf '  Arquitetura: %s (%s)\n' "$machine" "$NODE_ARCH"
printf '  Pasta: %s\n' "$PROJECT_ROOT"
printf '  Node portátil: %s\n' "$node_version"
if [ -f "$PROJECT_ROOT/.env" ]; then
  printf '  Configuração: .env encontrado\n'
else
  printf '  Configuração: assistente será aberto na primeira execução\n'
fi

if [ "$MODE" = diagnostic ]; then
  printf '  Diagnóstico concluído. Nenhuma instalação foi executada.\n\n'
  exit 0
fi

for tool in curl tar awk shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "O macOS não encontrou a ferramenta básica '$tool'. Atualize o sistema e tente novamente."
done

download_to() {
  url=$1
  destination=$2
  partial="$destination.parcial"
  rm -f "$partial"
  if ! curl --fail --location --silent --show-error "$url" --output "$partial"; then
    rm -f "$partial"
    return 1
  fi
  mv "$partial" "$destination"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{ print tolower($1) }'
}

install_node() {
  if [ -x "$NODE_BIN" ]; then
    version=$($NODE_BIN --version 2>/dev/null || true)
    case "$version" in
      v22.*|v23.*|v24.*) step "Node portátil $version reutilizado."; return ;;
      *) die "O runtime local existe, mas não é uma versão aceita ($version). Apague somente $NODE_ROOT e tente novamente." ;;
    esac
  fi

  mkdir -p "$RUNTIME_ROOT"
  checksums="$RUNTIME_ROOT/SHASUMS256.txt"
  step 'Consultando a versão oficial mais recente do Node.js 22 LTS…'
  download_to "$NODE_DIST_BASE/SHASUMS256.txt" "$checksums" || die 'Não foi possível baixar a lista oficial de hashes do Node.js.'

  pair=$(awk -v suffix="darwin-$NODE_ARCH.tar.gz" '$2 ~ suffix "$" { print tolower($1) " " $2; exit }' "$checksums")
  expected=$(printf '%s' "$pair" | awk '{ print $1 }')
  archive_name=$(printf '%s' "$pair" | awk '{ print $2 }')
  case "$archive_name" in
    node-v22.*-darwin-"$NODE_ARCH".tar.gz) ;;
    *) die "O Node.js não publicou um pacote macOS compatível com $NODE_ARCH." ;;
  esac

  archive="$RUNTIME_ROOT/$archive_name"
  step "Baixando $archive_name…"
  download_to "$NODE_DIST_BASE/$archive_name" "$archive" || die 'Falha no download oficial do Node.js.'
  actual=$(sha256_file "$archive")
  if [ "$actual" != "$expected" ]; then
    rm -f "$archive"
    die 'A verificação SHA-256 do Node.js falhou. O arquivo foi descartado.'
  fi

  staging="$RUNTIME_ROOT/extracting-darwin-$NODE_ARCH"
  rm -rf "$staging"
  mkdir -p "$staging"
  if ! tar -xzf "$archive" -C "$staging"; then
    rm -rf "$staging"
    die 'O pacote oficial do Node.js não pôde ser extraído.'
  fi
  set -- "$staging"/node-v22.*-darwin-"$NODE_ARCH"
  [ "$#" -eq 1 ] && [ -x "$1/bin/node" ] || die 'O pacote foi extraído, mas o executável do Node.js não foi encontrado.'
  mv "$1" "$NODE_ROOT"
  rm -rf "$staging"
  rm -f "$archive" "$checksums"
  step "Node.js $($NODE_BIN --version) instalado somente em .runtime."
}

install_dependencies() {
  current_hash=$(sha256_file "$LOCK_FILE")
  fingerprint="$current_hash|darwin|$NODE_ARCH"
  saved=''
  [ ! -f "$DEPENDENCY_MARKER" ] || saved=$(sed -n '1p' "$DEPENDENCY_MARKER")

  if [ "$fingerprint" = "$saved" ] && [ -f "$PROJECT_ROOT/node_modules/vite/bin/vite.js" ]; then
    step 'Dependências já estão prontas para este Mac.'
    return
  fi

  step 'Instalando dependências travadas pelo package-lock.json…'
  mkdir -p "$BOOTSTRAP_ROOT" "$PROJECT_ROOT/.cache/npm"
  PATH="$NODE_ROOT/bin:$PATH"
  export PATH
  export npm_config_cache="$PROJECT_ROOT/.cache/npm"
  if ! "$NPM_BIN" ci --no-audit --no-fund; then
    die 'npm ci falhou. Confira a conexão e as linhas de erro acima.'
  fi
  printf '%s' "$fingerprint" > "$DEPENDENCY_MARKER"
}

install_node
install_dependencies

if [ "$MODE" = tunnel ]; then
  PATH="$NODE_ROOT/bin:$PATH"
  export PATH
  export npm_config_cache="$PROJECT_ROOT/.cache/npm"
  exec "$NPM_BIN" run tunel:criar
fi

if [ "$MODE" = prepare ]; then
  printf '\n  %bRuntime e dependências prontos para macOS.%b\n\n' "$GREEN" "$RESET"
  exit 0
fi

printf '\n  %bIniciando a Sala de Tela…%b\n' "$GREEN" "$RESET"
note 'Use Ctrl+C para encerrar servidor e túnel.'
printf '\n'
PATH="$NODE_ROOT/bin:$PATH"
export PATH
export npm_config_cache="$PROJECT_ROOT/.cache/npm"
export npm_execpath="$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js"
exec "$NODE_BIN" "$PROJECT_ROOT/scripts/start-fast.mjs"
