# Instalação e diagnóstico no macOS

## Começo rápido

1. Baixe o ZIP e extraia a pasta inteira em Downloads ou Documentos.
2. Dê dois cliques em `INICIAR.command`.
3. Se o macOS bloquear a primeira abertura, clique com o botão direito no
   arquivo, escolha **Abrir** e confirme **Abrir**. Não desative o Gatekeeper.
4. Cole o Client ID e o Client Secret quando o assistente local pedir.
5. Mantenha o Terminal aberto; `Control+C` encerra servidor e túnel.

Se o programa de ZIP não preservar a permissão de execução, abra o Terminal na
pasta extraída e execute uma única vez:

```bash
chmod +x INICIAR.command scripts/macos-bootstrap.sh
./INICIAR.command
```

Depois disso, o duplo clique funciona normalmente.

## O que o inicializador faz

O launcher:

1. identifica macOS Intel (`x64`) ou Apple Silicon (`arm64`);
2. baixa o pacote oficial mais recente do Node.js 22 LTS para a CPU;
3. compara o SHA-256 com `SHASUMS256.txt` publicado no mesmo release;
4. instala as versões travadas no `package-lock.json` somente dentro da pasta;
5. baixa/reutiliza o `cloudflared` oficial correspondente à arquitetura;
6. configura, compila e inicia servidor e túnel na mesma janela.

O script usa somente ferramentas que acompanham o macOS (`curl`, `tar`, `awk`
e `shasum`). Não instala Homebrew, não pede `sudo`, não altera o `PATH`
permanente e não cria serviço de inicialização.

## Compatibilidade e mídia

- macOS em Apple Silicon e Intel com pacotes oficiais do Node.js 22;
- Chrome, Edge, Brave e Opera são o caminho mais previsível para transmitir
  tela e o áudio que o seletor do navegador oferecer;
- Safari e Firefox podem assistir e podem transmitir vídeo quando expõem
  WebCodecs/captura, mas áudio isolado por processo não está disponível como no
  capturador WASAPI do Windows;
- o macOS pedirá permissão de **Gravação de Tela e Áudio do Sistema** ao
  navegador. Autorize em Ajustes do Sistema e reinicie o navegador se solicitado.

O launcher torna servidor, site e túnel compatíveis com macOS. Ele não contorna
permissões de privacidade nem cria áudio que o navegador não entrega.

## Comandos úteis

```bash
./INICIAR.command --diagnostico
./INICIAR.command --preparar
./INICIAR.command --tunel-criar
```

O diagnóstico não instala nem inicia nada e não imprime segredos.

## Remoção

Tudo que o bootstrap cria fica no projeto (`.runtime`, `.cache`, `.bootstrap`,
`node_modules` e `.env`). Preserve `.env` se quiser guardar a configuração;
apagar a pasta remove o restante sem desinstalador.
