#!/bin/sh
# Inicializador de duplo clique para macOS. Resolve a pasta do projeto porque
# o Finder costuma abrir arquivos .command com outra pasta de trabalho.

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
chmod +x "$SCRIPT_DIR/INICIAR.command" "$SCRIPT_DIR/scripts/macos-bootstrap.sh" 2>/dev/null || true

sh "$SCRIPT_DIR/scripts/macos-bootstrap.sh" "$@"
status=$?

# Quando aberto pelo Finder, mantenha o erro visível. No Terminal/CI não cria
# uma pausa inesperada.
if [ "$status" -ne 0 ] && [ "$status" -ne 130 ] && [ "$status" -ne 143 ] && [ -t 0 ]; then
  printf '\n  Pressione Enter para fechar…'
  IFS= read -r _resposta
fi

exit "$status"
