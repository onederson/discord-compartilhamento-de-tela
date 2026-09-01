# Instalação e diagnóstico no Windows

## O que `INICIAR.bat` faz

O `.bat` somente localiza o Windows PowerShell e entrega o controle a `scripts/windows-bootstrap.ps1`. O PowerShell:

1. valida Windows, PowerShell, arquitetura, `package-lock.json` e permissão de gravação;
2. reutiliza `.runtime/node/node.exe` quando ele é compatível;
3. se faltar, consulta `nodejs.org`, seleciona a versão 22 LTS mais recente e baixa o ZIP oficial;
4. compara o SHA-256 do ZIP com `SHASUMS256.txt` publicado no mesmo release;
5. executa `npm ci`, que instala exatamente o lockfile, apenas quando necessário;
6. inicia `scripts/start-fast.mjs` com o Node portátil.

Nenhuma variável permanente é criada. O `PATH` é alterado somente dentro do processo atual para que o npm encontre o Node portátil. Fechar a janela desfaz isso automaticamente.

## Compatibilidade

- Windows 10/11 de 64 bits (x64);
- Windows 11 ARM64 quando o release oficial do Node fornecer o pacote correspondente;
- Windows x86 quando ainda houver pacote oficial compatível;
- Windows PowerShell 5.1 ou PowerShell 7.

O projeto suporta caminhos com espaços e Unicode. Não extraia em `Program Files`, raiz do disco ou pasta sem permissão de gravação.

## Arquivos e remoção

Tudo criado pelo bootstrap fica no diretório do projeto. Para remover completamente:

1. encerre com `Ctrl+C`;
2. preserve `.env` se quiser manter credenciais/configuração;
3. apague a pasta do projeto.

Não há serviço, tarefa agendada, chave de Registro ou programa global para desinstalar.

## Diagnóstico

```powershell
.\INICIAR.bat -Diagnostico
```

O modo de diagnóstico não baixa nem inicia nada. Ele evita mostrar valores do `.env`.

Para conferir a porta sem finalizar processos:

```powershell
Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

Para identificar o processo encontrado:

```powershell
Get-Process -Id <PID>
```

Só encerre o processo se você confirmar que pertence a outra execução desta aplicação.

## Logs e falhas de rede

Servidor e túnel aparecem na mesma janela com prefixos diferentes. O `cloudflared` tenta reconectar suas conexões internas; se o executável encerrar, o supervisor do projeto o recria com atrasos de 2, 4, 8, 16 e no máximo 30 segundos.

Quick Tunnel recriado recebe outro hostname. O `.env` e o servidor são atualizados, mas o Discord Developer Portal não pode ser editado automaticamente. Named Tunnel conserva o hostname e é recomendado.
