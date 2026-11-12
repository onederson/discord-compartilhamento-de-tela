// Só o Discord de verdade: o webhook recebe texto de usuário e, em denúncias,
// imagens. Aceitar qualquer URL faria deste servidor um mandante de POST para
// onde o .env mandar, e um erro de digitação mandaria os relatos a um terceiro.
const PREFIXOS_WEBHOOK = [
  'https://discord.com/api/webhooks/',
  'https://discordapp.com/api/webhooks/',
];

const TIMEOUT_MS = 10_000;

const COR_BUG = 0xe2a13c;
const COR_DENUNCIA = 0xf2762e;
const COR_URGENTE = 0xe5484d;

export const CATEGORIAS = {
  sexual: 'Conteúdo sexual',
  violencia: 'Violência',
  odio: 'Discurso de ódio',
  menores: 'Risco a menores',
  ilegal: 'Atividade ilegal',
  golpe: 'Golpe ou fraude',
  pirataria: 'Pirataria',
  dados: 'Dados pessoais expostos',
  outro: 'Outro',
};

export function webhookValido(url) {
  return typeof url === 'string' && PREFIXOS_WEBHOOK.some((p) => url.startsWith(p));
}

/** Corta no limite do Discord sem deixar o embed inteiro ser recusado por um campo grande. */
const cortar = (valor, max) => {
  const texto = String(valor ?? '');
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
};

const campo = (name, value, inline = true) => ({
  name,
  value: cortar(value || '—', 1000),
  inline,
});

/** "Discord · celular · Chrome/148…" a partir do contexto que o cliente manda. */
export function descreverPlataforma(contexto) {
  if (!contexto || typeof contexto !== 'object') return null;
  const partes = [];
  if (contexto.inDiscord === true) partes.push('Discord');
  else if (contexto.inDiscord === false) partes.push('site');
  if (contexto.clienteMovel === true) partes.push('celular');
  if (typeof contexto.userAgent === 'string') partes.push(contexto.userAgent.slice(0, 60));
  return partes.length ? partes.join(' · ') : null;
}

/**
 * A mensagem do webhook para um relato salvo. Pura: não toca em rede nem em
 * disco, então dá para testar o que o Discord vai receber.
 */
export function montarMensagem(relato, publicOrigin) {
  const denuncia = relato.tipo === 'denuncia';
  const urgente = Boolean(relato.urgente);
  const categoria = CATEGORIAS[relato.categoria] ?? 'Outro';

  const titulo = urgente
    ? '🚨 URGENTE — risco a menores'
    : denuncia
      ? `🚩 Denúncia: ${categoria}`
      : '🐞 Problema relatado';

  // A atividade manda inDiscord/clienteMovel/userAgent; a aba de captura, só
  // userAgent. Daí sai um rótulo curto para quem lê o aviso no canal.
  const plataforma = descreverPlataforma(relato.contexto);

  const painel = `${String(publicOrigin).replace(/\/+$/, '')}/admin#relato-${relato.id}`;

  // Prints nunca existem em denúncia de menores; a checagem aqui é a segunda
  // trava, caso um relato mal formado chegue com contagem.
  const prints = !urgente && relato.prints > 0 ? relato.prints : 0;

  // Gravidade antes do texto: dá para saber o nível só pela barra e pela cor
  // da borda; o rótulo ao lado confirma para quem não distingue as cores.
  const nivel = urgente ? '🟥🟥🟥 Urgente' : denuncia ? '🟧🟧⬜ Denúncia' : '🟨⬜⬜ Problema';

  // O que pede ação fica no corpo: quem agir (o alvo), o aviso e o link que
  // resolve, juntos. Texto de usuário entra só na descrição e nos valores.
  const campos = [];
  if (denuncia) {
    campos.push(
      campo('Quem transmitia', `${relato.alvo?.nome ?? '—'} (${relato.alvo?.uid ?? '—'})`),
      campo('Fonte', relato.alvo?.fonte),
    );
  }
  if (urgente) {
    campos.push(
      campo(
        '⚠️ Atenção',
        `Nenhuma imagem foi guardada. [Encerre/bloqueie pelo painel](${painel}) e denuncie ao Discord e à SaferNet.`,
        false,
      ),
    );
  } else {
    campos.push(
      campo(
        'Resolver',
        denuncia
          ? `[Encerrar, bloquear ou resolver no painel](${painel})`
          : `[Abrir e resolver no painel](${painel})`,
        false,
      ),
    );
  }

  // Quem relatou, onde e de qual plataforma são contexto, não o assunto: vão
  // compactos no rodapé, que o Discord mostra menor e sem interpretar markdown.
  const rodape = [
    relato.quem?.nome ? `Relatado por ${relato.quem.nome}` : null,
    relato.sala?.nome ? `${relato.sala.nome} (${relato.sala.id})` : relato.sala?.id,
    relato.origem,
    typeof plataforma === 'string' ? plataforma : null,
    prints > 0 ? `📎 ${prints} ${prints === 1 ? 'print' : 'prints'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const embed = {
    title: titulo,
    description: `${nivel}\n\n${cortar(relato.texto || '(sem texto)', 1000 - nivel.length - 2)}`,
    color: urgente ? COR_URGENTE : denuncia ? COR_DENUNCIA : COR_BUG,
    fields: campos,
    url: painel,
    timestamp: relato.criadoEm,
  };
  if (rodape) embed.footer = { text: cortar(rodape, 2000) };
  if (prints > 0) embed.image = { url: 'attachment://print-1.jpg' };

  return {
    // Curto: é o que aparece na notificação. O aviso completo está no embed,
    // ao lado do link que resolve.
    content: urgente ? '🚨 **URGENTE** — risco a menores' : undefined,
    embeds: [embed],
    // Vazio de propósito: o texto é de quem relatou, e sem isto um "@everyone"
    // escrito no relato acordaria o canal inteiro.
    allowed_mentions: { parse: [] },
  };
}

/**
 * Envia ao webhook. Nunca lança: o relato já está salvo, e uma falha do Discord
 * não pode virar erro para quem relatou. O que deu errado vai ao diagnóstico,
 * sem a URL, que é uma credencial.
 *
 * @param {Buffer[]} arquivos JPEGs, anexados como print-1.jpg...
 */
export async function enviarWebhook(
  url,
  mensagem,
  arquivos = [],
  { log = () => {}, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {},
) {
  if (!webhookValido(url)) return false;

  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(mensagem));
    arquivos.forEach((buf, i) => {
      form.append(`files[${i}]`, new Blob([buf], { type: 'image/jpeg' }), `print-${i + 1}.jpg`);
    });

    const resposta = await fetchImpl(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resposta.ok) {
      log('relato.webhook-erro', { status: resposta.status });
      return false;
    }
    return true;
  } catch (err) {
    log('relato.webhook-erro', { status: 0, erro: err?.name ?? 'erro' });
    return false;
  }
}
