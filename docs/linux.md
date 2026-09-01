# Instalação e diagnóstico no Linux

## Começo rápido

Baixe o ZIP, extraia numa pasta do seu usuário e execute:

```bash
sh INICIAR.sh
```

Usar `sh` funciona mesmo quando o gerenciador de ZIP não preserva a permissão
de execução. Depois da primeira chamada o próprio launcher tenta marcar os
scripts como executáveis, então `./INICIAR.sh` também passa a funcionar.

O fluxo é o mesmo do Windows: o assistente pede as credenciais somente quando
faltam, monta o site, abre o túnel, mostra o Target/Redirect do portal e mantém
servidor e Cloudflare na mesma janela. `Ctrl+C` encerra ambos.

## O que é instalado

O launcher:

1. valida Linux, arquitetura, `package-lock.json` e permissão de gravação;
2. reutiliza `.runtime/node-linux-<arquitetura>/bin/node` quando a versão é compatível;
3. baixa o Node.js 22 LTS oficial correspondente à CPU;
4. confere o arquivo com o `SHASUMS256.txt` do mesmo release;
5. executa `npm ci` com o lockfile e cache dentro do projeto;
6. baixa/reutiliza o `cloudflared` oficial e inicia o aplicativo.

Node.js, npm, módulos e Cloudflare não são instalados globalmente. O `PATH` é
alterado somente no processo do launcher. Se faltarem ferramentas de sistema
básicas, ele reconhece e usa:

- `apt-get`: Ubuntu, Debian, Kali, Linux Mint e derivados;
- `dnf` ou `yum`: Fedora, RHEL, Rocky, AlmaLinux e derivados;
- `pacman`: Arch Linux e Manjaro;
- `zypper`: openSUSE.

Nesse único caso o gerenciador da distro pode pedir a senha do `sudo` para
instalar `ca-certificates`, `curl`, `tar`, `xz`, `awk` e SHA-256. O launcher
não executa `curl | sh` e verifica o hash do Node antes de extrair.

## Compatibilidade

- CPUs x86-64, ARM64 e ARMv7 para as quais Node.js e Cloudflare publicam
  binários oficiais;
- distribuições baseadas em glibc com um dos gerenciadores acima;
- X11 e Wayland: a seleção da janela/tela é controlada pelo navegador e pelo
  portal de captura da sessão gráfica;
- WSL2 pode hospedar servidor/túnel, mas a captura continua sendo feita pelo
  navegador que o usuário abriu.

Alpine usa musl, enquanto o pacote portátil oficial do Node usado aqui espera
glibc. Para Alpine, prefira o Dockerfile do projeto ou instale uma versão
compatível de Node pela própria distro e siga o fluxo de desenvolvimento. O
launcher não finge compatibilidade baixando um binário que não executará.

No Linux, Chrome/Chromium, Brave e Opera são o caminho recomendado para
transmitir com áudio quando o seletor oferecer a faixa. O Firefox transmite
vídeo, mas não fornece áudio de tela pelo `getDisplayMedia()`; a ponte nativa
WASAPI desta edição é exclusiva do Windows.

## Diagnóstico e preparação

Verificar sem baixar ou iniciar:

```bash
sh INICIAR.sh --diagnostico
```

Preparar Node e dependências sem subir servidor/túnel:

```bash
sh INICIAR.sh --preparar
```

Criar uma vez um túnel de endereço fixo:

```bash
sh INICIAR.sh --tunel-criar
```

O diagnóstico não lê nem imprime os valores do `.env`.

Para conferir a porta sem finalizar nada:

```bash
ss -ltnp 'sport = :3001'
```

Encerre um PID somente depois de confirmar que pertence a outra execução da
Sala de Tela.

## Atualização, dual boot e remoção

`node_modules` contém pequenos binários específicos do sistema. O marcador de
instalação agora inclui sistema e arquitetura; abrir a mesma pasta pelo Windows
e depois pelo Linux força `npm ci` quando necessário, em vez de reutilizar um
módulo incompatível.

Para reinstalar apenas o runtime e dependências, preserve `.env` e remova:

```bash
rm -rf -- .runtime .bootstrap node_modules
```

Esses alvos são todos locais ao projeto. Para remover tudo, encerre com
`Ctrl+C`, preserve `.env` se quiser manter a configuração e apague a pasta
extraída. Nenhum serviço ou variável permanente é criado pelo launcher.
