#!/usr/bin/env sh
# Inicializador de um clique para Linux. Também funciona quando o ZIP perdeu o
# bit de execução: `sh INICIAR.sh` não depende dele.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
chmod +x "$SCRIPT_DIR/INICIAR.sh" "$SCRIPT_DIR/scripts/linux-bootstrap.sh" 2>/dev/null || true
exec sh "$SCRIPT_DIR/scripts/linux-bootstrap.sh" "$@"
