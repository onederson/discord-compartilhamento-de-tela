import fs from 'node:fs';
import express from 'express';

import { SENSITIVE_KEY } from '../scripts/diagnostics.mjs';
import { CATEGORIAS, enviarWebhook, montarMensagem, webhookValido } from './webhook.js';

const ORIGENS_BUG = new Set(['atividade', 'captura']);
const CATEGORIAS_DENUNCIA = new Set(Object.keys(CATEGORIAS));

const TEXTO_BUG_MIN = 10;
const TEXTO_BUG_MAX = 2000;
const TEXTO_DENUNCIA_MAX = 1000;
const TEXTO_OUTRO_MIN = 5;
const CONTEXTO_MAX_BYTES = 200_000;
const MAX_PRINTS = 4;
const PRINT_MAX_BYTES = 400 * 1024;
const PROFUNDIDADE_MAX = 20;

const MOTIVO_ENCERRAMENTO = 'Sua transmissão foi encerrada pela moderação.';

const PREFIXO_JPEG = 'data:image/jpeg;base64,';

export const LIMITES_PADRAO = { porUid: 5, porIp: 20, janelaMs: 10 * 60 * 1000 };

/** Tira, em qualquer nível, as chaves que parecem credencial. */
export function limparContexto(valor, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAX) return '[LIMITE]';
  if (Array.isArray(valor)) return valor.map((v) => limparContexto(v, profundidade + 1));
  if (valor && typeof valor === 'object') {
    const saida = {};
    for (const [chave, v] of Object.entries(valor)) {
      // __proto__ viria como chave própria do JSON.parse e trocaria o protótipo
      // do objeto de saída na atribuição.
      if (chave === '__proto__' || SENSITIVE_KEY.test(chave)) continue;
      saida[chave] = limparContexto(v, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

/**
 * Decodifica um print da denúncia, ou null se não for um JPEG aceitável.
 * Confere os bytes, não o prefixo declarado: "data:image/jpeg" é só o que o
 * cliente diz que mandou.
 */
export function decodificarPrint(texto) {
  if (typeof texto !== 'string' || !texto.startsWith(PREFIXO_JPEG)) return null;
  // Antes de decodificar: base64 ocupa 4/3 do binário, e não vale alocar o que
  // já se sabe que passa do teto.
  if (texto.length > Math.ceil((PRINT_MAX_BYTES * 4) / 3) + PREFIXO_JPEG.length + 4) return null;
  const base64 = texto.slice(PREFIXO_JPEG.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 4 || buf.length > PRINT_MAX_BYTES) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

/** O estado da sala no momento do relato, para o admin entender o cenário. */
export function retratoSala(room) {
  if (!room) return null;
  return {
    id: room.id,
    nome: room.name,
    viewers: room.viewers.size,
    broadcasters: [...room.broadcasters.values()].map((e) => ({
      slot: e.slot,
      fonte: e.fonte,
      streaming: Boolean(e.streaming),
      disconnected: Boolean(e.disconnected),
    })),
    controles: room.controles.size,
  };
}

const textoDe = (valor) => (typeof valor === 'string' ? valor.trim() : '');

/**
 * As rotas de relato e de moderação.
 *
 * Em fábrica para o teste montar com fakes (sala, buffer, webhook, relógio) em
 * vez de subir o servidor inteiro. `publicas` precisa ser montada ANTES do
 * `express.json()` global: o limite padrão dele (100kb) recusaria um relato com
 * contexto grande e uma denúncia com prints, e cada rota aqui traz o seu.
 */
export function criarRotasRelatos({
  relatos,
  verifyToken,
  salas,
  eventos,
  log = () => {},
  pessoa,
  requireAdmin,
  publicOrigin,
  webhookUrl = () => process.env.DISCORD_WEBHOOK_RELATOS ?? '',
  enviar = enviarWebhook,
  limites = LIMITES_PADRAO,
  agora = () => Date.now(),
}) {
  // ------------------------------------------------------------ limite de uso

  const porUid = new Map();
  const porIp = new Map();

  function recentes(mapa, chave) {
    const corte = agora() - limites.janelaMs;
    const lista = (mapa.get(chave) ?? []).filter((t) => t > corte);
    if (lista.length) mapa.set(chave, lista);
    else mapa.delete(chave);
    return lista;
  }

  const excedeu = (uid, ip) =>
    recentes(porUid, uid).length >= limites.porUid || recentes(porIp, ip).length >= limites.porIp;

  // Só conta o que foi aceito: um texto curto demais não deve gastar a cota de
  // quem está tentando relatar de verdade.
  function contar(uid, ip) {
    for (const [mapa, chave] of [
      [porUid, uid],
      [porIp, ip],
    ]) {
      mapa.set(chave, [...recentes(mapa, chave), agora()]);
    }
    // Chaves de quem nunca mais voltou não podem acumular para sempre.
    if (porIp.size > 1000) for (const chave of [...porIp.keys()]) recentes(porIp, chave);
    if (porUid.size > 1000) for (const chave of [...porUid.keys()]) recentes(porUid, chave);
  }

  const ipDe = (req) => req.ip || req.socket?.remoteAddress || 'desconhecido';

  /** O token de sala de quem relata, ou responde 401/429 e devolve null. */
  function autorizar(req, res, { somenteViewer = false } = {}) {
    const auth = verifyToken(req.body?.token);
    if (
      !auth ||
      !auth.room ||
      !auth.uid ||
      auth.scope === 'identity' ||
      (somenteViewer && auth.role !== 'viewer')
    ) {
      res.status(401).json({ error: 'Sessão inválida ou expirada. Reabra a atividade.' });
      return null;
    }
    if (excedeu(String(auth.uid), ipDe(req))) {
      res
        .status(429)
        .json({ error: 'Muitos relatos em pouco tempo. Tente de novo em alguns minutos.' });
      return null;
    }
    return auth;
  }

  function notificar(id, imagens) {
    const url = webhookUrl();
    if (!webhookValido(url)) return;
    const relato = relatos.ler(id);
    if (!relato) return;
    // Sem await: o relato já está salvo, e o Discord lento não deve segurar a resposta.
    enviar(url, montarMensagem(relato, publicOrigin), imagens, { log });
  }

  // ------------------------------------------------------------------ públicas

  const publicas = express.Router();

  /** Relato de problema: texto obrigatório e o contexto que o cliente juntou. */
  publicas.post('/bug', express.json({ limit: '300kb' }), (req, res) => {
    const auth = autorizar(req, res);
    if (!auth) return;

    const { origem, contexto } = req.body;
    const texto = textoDe(req.body.texto);

    if (!ORIGENS_BUG.has(origem))
      return res.status(400).json({ error: 'Origem do relato inválida.' });
    if (texto.length < TEXTO_BUG_MIN || texto.length > TEXTO_BUG_MAX) {
      return res.status(400).json({
        error: `Descreva o problema com ${TEXTO_BUG_MIN} a ${TEXTO_BUG_MAX} caracteres.`,
      });
    }

    let contextoLimpo = null;
    if (contexto != null) {
      if (typeof contexto !== 'object' || Array.isArray(contexto)) {
        return res.status(400).json({ error: 'Contexto inválido.' });
      }
      if (Buffer.byteLength(JSON.stringify(contexto)) > CONTEXTO_MAX_BYTES) {
        return res.status(400).json({ error: 'O contexto do relato é grande demais.' });
      }
      contextoLimpo = limparContexto(contexto);
    }

    const quem = pessoa(auth.uid);
    const room = salas.getRoom(auth.room);
    const id = relatos.salvar('bug', {
      origem,
      texto,
      contexto: contextoLimpo,
      quem: { uid: String(auth.uid), nome: String(auth.name ?? '').slice(0, 64) },
      sala: { id: auth.room, nome: room?.name ?? null },
      servidor: {
        eventos: eventos.recentes((e) => e.data?.sala === auth.room || e.data?.pessoa === quem),
        sala: retratoSala(room),
      },
    });

    contar(String(auth.uid), ipDe(req));
    log('relato.criado', { tipo: 'bug', origem, sala: auth.room, pessoa: quem });
    notificar(id, []);
    res.json({ ok: true, id });
  });

  /** Denúncia de uma transmissão no ar, com prints opcionais. */
  publicas.post('/denuncia', express.json({ limit: '3mb' }), (req, res) => {
    const auth = autorizar(req, res, { somenteViewer: true });
    if (!auth) return;

    const { slot, categoria, prints } = req.body;
    const texto = textoDe(req.body.texto);

    const room = salas.getRoom(auth.room);
    const entry = Number.isInteger(slot) ? room?.slots.get(slot) : null;
    if (!entry?.streaming) {
      return res.status(404).json({ error: 'Essa transmissão não está mais no ar.' });
    }
    if (String(entry.info.id) === String(auth.uid)) {
      return res.status(400).json({ error: 'Você não pode denunciar a sua própria transmissão.' });
    }
    if (!CATEGORIAS_DENUNCIA.has(categoria)) {
      return res.status(400).json({ error: 'Escolha uma categoria para a denúncia.' });
    }
    if (texto.length > TEXTO_DENUNCIA_MAX) {
      return res.status(400).json({
        error: `O texto da denúncia aceita até ${TEXTO_DENUNCIA_MAX} caracteres.`,
      });
    }
    if (categoria === 'outro' && texto.length < TEXTO_OUTRO_MIN) {
      return res.status(400).json({ error: 'Descreva o motivo da denúncia.' });
    }

    // Material de abuso infantil: guardar ou repassar a imagem já é crime (ECA,
    // art. 241-B), mesmo que a intenção seja denunciar. Por isso o descarte
    // acontece aqui, antes de qualquer gravação, e o relato vira só um alerta
    // para o admin agir pelo painel e denunciar às autoridades.
    const urgente = categoria === 'menores';
    const imagens = urgente
      ? []
      : (Array.isArray(prints) ? prints.slice(0, MAX_PRINTS) : [])
          .map(decodificarPrint)
          .filter(Boolean);

    const quem = pessoa(auth.uid);
    const id = relatos.salvar(
      'denuncia',
      {
        origem: 'atividade',
        categoria,
        urgente,
        texto,
        quem: { uid: String(auth.uid), nome: String(auth.name ?? '').slice(0, 64) },
        alvo: {
          uid: String(entry.info.id),
          nome: String(entry.info.name ?? '').slice(0, 64),
          fonte: entry.fonte,
          slot,
          transmitindoHaS: entry.startedAt ? Math.round((agora() - entry.startedAt) / 1000) : null,
        },
        sala: { id: room.id, nome: room.name },
        servidor: { sala: retratoSala(room) },
      },
      imagens,
    );

    contar(String(auth.uid), ipDe(req));
    log('relato.criado', {
      tipo: 'denuncia',
      categoria,
      urgente,
      prints: imagens.length,
      sala: room.id,
      pessoa: quem,
      alvo: pessoa(entry.info.id),
    });
    notificar(id, imagens);
    res.json({ ok: true, id });
  });

  // Corpo grande demais ou JSON quebrado: o cliente espera {error}, não a página
  // de erro do Express.
  publicas.use((err, _req, res, _next) => {
    const tamanho = err?.type === 'entity.too.large';
    res.status(tamanho ? 413 : 400).json({
      error: tamanho ? 'O relato é grande demais.' : 'Pedido inválido.',
    });
  });

  // --------------------------------------------------------------------- admin

  const admin = express.Router();

  const ORIGENS_LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]']);

  /**
   * Nas ações que mudam estado, a origem tem que ser a do próprio painel. O
   * cookie é SameSite=Lax, mas isto não depende de o navegador respeitá-lo.
   */
  function origemPermitida(req) {
    try {
      const origem = new URL(req.get('origin') ?? '');
      return origem.origin === new URL(publicOrigin).origin || ORIGENS_LOCAIS.has(origem.hostname);
    } catch {
      return false;
    }
  }

  function exigirOrigem(req, res, next) {
    if (!origemPermitida(req)) return res.status(403).json({ error: 'origem_nao_permitida' });
    next();
  }

  const uidValido = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 64;

  /** Derruba o que a pessoa transmite em toda sala. Devolve quantas transmissões. */
  function encerrarEmTodas(uid) {
    let encerradas = 0;
    for (const room of salas.salasAbertas()) {
      if (!salas.broadcastersOf(room, uid).length) continue;
      encerradas += salas.encerrarPresenca(room, uid, MOTIVO_ENCERRAMENTO, 'moderacao');
    }
    return encerradas;
  }

  const STATUS = new Set(['aberto', 'resolvido']);

  admin.get('/relatos', requireAdmin, (req, res) => {
    const tipo = ['bug', 'denuncia'].includes(req.query.tipo) ? req.query.tipo : undefined;
    const status = STATUS.has(req.query.status) ? req.query.status : undefined;
    res.json({ relatos: relatos.listar({ tipo, status, limite: 200 }) });
  });

  admin.get('/relatos/:id', requireAdmin, (req, res) => {
    const relato = relatos.ler(req.params.id);
    if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });
    res.json(relato);
  });

  admin.get('/relatos/:id/print/:n', requireAdmin, (req, res) => {
    // Lido para a memória em vez de sendFile: o caminho passa por ".dados", e o
    // sendFile recusa qualquer caminho com pasta oculta.
    const arquivo = relatos.caminhoPrint(req.params.id, req.params.n);
    if (!arquivo) return res.status(404).json({ error: 'Print não encontrado.' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(fs.readFileSync(arquivo));
  });

  admin.post('/relatos/:id/resolver', requireAdmin, exigirOrigem, (req, res) => {
    const relato = relatos.marcarResolvido(req.params.id, req.body?.nota, req.admin.name);
    if (!relato) return res.status(404).json({ error: 'Relato não encontrado.' });
    log('relato.resolvido', { id: relato.id, tipo: relato.tipo, admin: pessoa(req.admin.uid) });
    res.json({ ok: true });
  });

  admin.post('/moderacao/encerrar', requireAdmin, exigirOrigem, (req, res) => {
    const uid = req.body?.uid;
    if (!uidValido(uid)) return res.status(400).json({ error: 'uid inválido.' });
    const encerradas = encerrarEmTodas(uid);
    log('moderacao.encerrar', { pessoa: pessoa(uid), encerradas, admin: pessoa(req.admin.uid) });
    res.json({ ok: true, encerradas });
  });

  admin.post('/moderacao/bloquear', requireAdmin, exigirOrigem, (req, res) => {
    const { uid, nome, motivo } = req.body ?? {};
    if (!uidValido(uid)) return res.status(400).json({ error: 'uid inválido.' });
    relatos.bloquear(uid, {
      nome: typeof nome === 'string' ? nome : '',
      motivo: typeof motivo === 'string' ? motivo : '',
      por: req.admin.name,
    });
    // O bloqueio vale para conexões novas; quem já está no ar precisa ser derrubado.
    const encerradas = encerrarEmTodas(uid);
    log('moderacao.bloquear', { pessoa: pessoa(uid), encerradas, admin: pessoa(req.admin.uid) });
    res.json({ ok: true, encerradas });
  });

  admin.post('/moderacao/desbloquear', requireAdmin, exigirOrigem, (req, res) => {
    const uid = req.body?.uid;
    if (!uidValido(uid)) return res.status(400).json({ error: 'uid inválido.' });
    const removido = relatos.desbloquear(uid);
    log('moderacao.desbloquear', { pessoa: pessoa(uid), admin: pessoa(req.admin.uid) });
    res.json({ ok: true, removido });
  });

  admin.get('/moderacao/bloqueios', requireAdmin, (_req, res) => {
    res.json({ bloqueios: relatos.listarBloqueios() });
  });

  return { publicas, admin };
}
