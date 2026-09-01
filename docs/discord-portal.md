# Erro `removeChild` no Developer Portal do Discord

## Sintoma

Em **OAuth2 → Redirecionamentos**, clicar no botão azul
**Redirecionamento** pode mostrar uma página cheia de linhas de
`discord.com/assets/...` e o erro:

```text
Falha ao executar 'removeChild' em 'Node': o nó a ser removido não é filho deste nó.
```

Esse erro vem do frontend do próprio Developer Portal. Ele acontece antes de o
endereço ser salvo e antes de qualquer comunicação com a Sala de Tela ou com o
Cloudflare. URL Mapping não precisa ser criado antes para o botão funcionar.

## Como resolver com segurança

1. Não cole nada no console de desenvolvedor e não execute scripts encontrados
   em comentários ou vídeos.
2. Recarregue completamente a página: `Ctrl+Shift+R` no Windows/Linux ou
   `Command+Shift+R` no macOS.
3. Desative, somente para `discord.com`, tradução automática e extensões que
   modificam páginas (tradutor, bloqueador, tema, userscript). Reabra o portal.
4. Se continuar, use uma janela anônima/privativa ou outro navegador atualizado
   e entre novamente na sua conta.
5. Volte a **OAuth2 → Redirecionamentos**. O botão azul deve apenas criar uma
   caixa vazia na mesma página.
6. Cole o endereço HTTPS mostrado pelo iniciador, terminado exatamente em
   `/auth/callback`, e clique em **Salvar alterações**.

Se o mesmo crash ocorrer em dois navegadores limpos, ele é uma indisponibilidade
do portal. Aguarde e tente novamente; o projeto não possui uma API oficial e
segura para editar essa lista em nome do dono da aplicação.

## Segurança do Client Secret

O Client Secret equivale a uma senha. Se ele apareceu numa captura de tela,
vídeo, comentário ou mensagem enviada a terceiros, use **OAuth2 → Redefinir**,
copie o novo valor para o assistente local e não publique a nova tela. A troca
invalida o segredo anterior.
