/**
 * Orientação para uma falha conhecida do frontend do Developer Portal.
 *
 * Não tentamos editar redirect_uris pela API: o endpoint oficial autenticado
 * pelo bot não aceita esse campo, e usar token de usuário ou endpoints internos
 * seria inseguro. O que controlamos é deixar o comportamento esperado e o
 * procedimento de recuperação impossíveis de confundir.
 */
export function ajudaRedirecionamento(redirectUri) {
  const url = new URL(redirectUri);
  if (url.protocol !== 'https:' || !url.hostname || url.pathname !== '/auth/callback') {
    throw new Error('O Redirect precisa ser HTTPS e terminar exatamente em /auth/callback.');
  }

  return {
    redirectUri: url.toString(),
    botao:
      'O botão azul "Redirecionamento" / "Add Redirect" deve criar uma caixa nesta mesma página; ele não abre outro site.',
    falha:
      'Se aparecer "removeChild" e uma tela cheia de código, o frontend do portal caiu: recarregue sem tradução automática/extensões ou tente uma janela anônima/outro navegador.',
    seguranca:
      'Não cole Client Secret no console e não use scripts para contornar o portal. Redefina o Secret se ele apareceu em uma captura pública.',
  };
}
