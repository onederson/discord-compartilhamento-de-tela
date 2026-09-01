# Diagnóstico e atualização

## Registro local

Por padrão, `DIAGNOSTICO_LOCAL=1` grava eventos técnicos em
`.logs/diagnostico.jsonl`. O arquivo gira ao chegar a 1 MB e mantém apenas a
cópia anterior. Ele não contém mídia, texto da tela, áudio, nome, ID do Discord,
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
