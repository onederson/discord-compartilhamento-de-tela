# Diagnóstico e atualização

## Registro local

Por padrão, `DIAGNOSTICO_LOCAL=1` grava eventos técnicos em
`.logs/diagnostico.jsonl`. O arquivo gira ao chegar a 5 MB e mantém as três
cópias anteriores (`.1`, a mais recente, até `.3`). Ele não contém mídia, texto da tela, áudio, nome, ID do Discord,
IP, Client Secret, tokens ou URL completa. Campos sensíveis e parâmetros de URL
são removidos antes da escrita.

Para criar um arquivo que possa ser anexado manualmente a uma issue:

```text
npm run diagnostico:exportar
```

O comando gera uma cópia sanitizada em `.logs/exports/` e informa o caminho.
Essa pasta é ignorada pelo Git, portanto exportar um relatório não bloqueia a
próxima atualização automática. Para desligar a escrita local, use
`DIAGNOSTICO_LOCAL=0` no `.env`.

## Eventos enviados pelo cliente

A Activity e a aba de captura mandam eventos pelo WebSocket, gravados como
`cliente.<evento>` com `papel`, `sala` e `pessoa` (pseudônimo estável, não o ID
do Discord). Só passam números, booleanos e textos de até 60 caracteres, com
chaves simples; cada socket manda no máximo 30 por minuto (o excedente vira um
`cliente.limite` por minuto). Eventos gerados com a conexão fora do ar esperam
numa fila de 20 e saem na reconexão. O log completo vem de
`/api/admin/diagnostico?kb=4096` (padrão 128, máximo 4096).

Quem assiste (Activity):

- `viewer-arranque`: ambiente ao abrir a conexão (`discord`, `movel`, `w`, `h`,
  `reconexao`). Mostra onde a Activity roda e se já caiu antes.
- `viewer-visibilidade`: aba oculta/visível enquanto assiste, com `ocultoMs` ao
  voltar. Responde se a janelinha ou o picture-in-picture do Discord conta como
  `hidden` (o player descarta quadros nesse estado).
- `viewer-tamanho`: tamanho da janela ao redimensionar enquanto assiste.
- `viewer-silencio`: o vigia derrubou um socket mudo (`ms`).
- `viewer-retomada`: retomada automática de uma transmissão (`fonte`,
  `ausenteMs`).
- `viewer-fila`: fila do decoder encheu ou normalizou (`tipo`, `fila`,
  `descartados`).
- `viewer-saude`: a cada 60 s, do stream em foco: `fps`, `lagMs`, `w`, `h`,
  `fila`, `recuperacoes`, `memMb`, `visivel`, `foco`, `telaCheia`, `streams`.

Quem transmite (aba de captura):

- `tx-codec`: encoder configurado (`codec`, `w`, `h`, `fps`, `bitrate`,
  `hardware`).
- `tx-saude`: a cada 60 s, `fps` de saída, `bitrate`, `w`, `h`, `viewers`,
  `quadrosDescartados`, `filaEncoder`, `bufferedKB`. Mostra se o gargalo é
  captura, encoder ou rede.
- `tx-qualidade`: adaptação automática (`motivo` rede, desempenho ou
  recuperou; `bitrate`, `w`, `h`).
- `tx-reconexao`: cada tentativa (`tentativa`, `atrasoMs`) e o sucesso (`ok`,
  `tentativas`, `foraMs`).
- `tx-captura-fim`: a faixa de vídeo terminou (`motivo`, `fonte`, `superficie`).
- `tx-captura-travou`: a página mostrou "A captura travou" (`fonte`).
- `tx-visibilidade`: aba de captura oculta/visível durante a transmissão, com
  `ocultoMs` ao voltar.
- `tx-erro`: erro do encoder (`origem`, `nome`, sem mensagem nem stack).

## Envio automático opcional

Nada é enviado na configuração padrão. Quem opera uma instância pode fornecer
um coletor próprio:

```text
DIAGNOSTICO_UPLOAD_URL=https://seu-dominio.example/diagnosticos
DIAGNOSTICO_UPLOAD_TOKEN=token-opcional
```

Ao iniciar, o programa envia no máximo 128 KB como
`application/x-ndjson`, por `POST`, com timeout de 8 segundos. URL externa deve
usar HTTPS; HTTP só é aceito em `localhost`. Se houver token, ele segue como
`Authorization: Bearer`. Falha no coletor não impede a Activity de iniciar.
Antes de habilitar esse envio para terceiros, o operador deve informar os
usuários, controlar acesso e definir sua própria retenção.

## Atualização automática

`ATUALIZACAO_AUTOMATICA=1` verifica atualizações durante a inicialização, mas
somente em um clone Git cujo `origin` seja o repositório oficial. Ela exige uma
árvore limpa e aplica exclusivamente `fast-forward` de `origin/main`; checkout
com arquivos modificados, commits próprios, divergência ou falha de rede
continua intacto. Depois de avançar, as dependências são sincronizadas antes do
build.

Um ZIP não possui `.git`, portanto não existe forma confiável de descobrir e
mesclar apenas arquivos do programa sem arriscar a configuração local. Nesse
caso, baixe a versão mais recente e preserve o `.env`. O programa nunca executa
`reset --hard`, stash automático ou troca forçada de branch.
