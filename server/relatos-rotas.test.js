/**
 * As rotas de relato e de moderação, montadas num Express próprio com sala,
 * webhook e relógio de mentira. O servidor inteiro é testado à parte, em
 * index-relatos.test.js; aqui o que importa são as regras de cada rota.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { signToken, verifyToken } from './tokens.js';
import { criarBufferEventos, criarRelatos } from './relatos.js';
import { criarRotasRelatos, decodificarPrint, limparContexto } from './relatos-rotas.js';

const ORIGEM = 'https://exemplo.test';
const pessoa = (uid) => `p-${uid}`;

const jpegBase64 = (extra = 10) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 1)]).toString('base64');
const printJpeg = (extra) => `data:image/jpeg;base64,${jpegBase64(extra)}`;

let base;
let relatos;
let eventos;
let enviar;
let salas;
let sala;
let server;
let url;
let seq = 0;
let adminLogado;
let encerrarChamadas;

function novaSala() {
  const ws = {};
  const entry = (uid, nome, slot) => ({
    ws,
    info: { id: uid, name: nome },
    fonte: 'tela',
    slot,
    streaming: true,
    startedAt: Date.now() - 65_000,
  });
  const room = {
    id: 'sala1',
    name: 'Sala de teste',
    viewers: new Set([1, 2]),
    broadcasters: new Map(),
    slots: new Map(),
    controles: new Set(),
  };
  const alvo = entry('alvo-1', 'Alvo', 0);
  const proprio = entry('quem-1', 'Quem', 1);
  const parado = { ...entry('alvo-2', 'Parado', 2), streaming: false };
  for (const e of [alvo, proprio, parado]) {
    room.slots.set(e.slot, e);
    room.broadcasters.set(`${e.info.id}|tela`, e);
  }
  return room;
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'rotas-'));
  relatos = criarRelatos({ base });
  eventos = criarBufferEventos();
  enviar = vi.fn();
  encerrarChamadas = [];
  sala = novaSala();
  salas = {
    getRoom: (id) => (id === sala.id ? sala : null),
    salasAbertas: () => [sala],
    broadcastersOf: (room, uid) => [...room.broadcasters.values()].filter((e) => e.info.id === uid),
    encerrarPresenca: (room, uid, motivo, origem) => {
      encerrarChamadas.push({ uid, motivo, origem });
      return salas.broadcastersOf(room, uid).length;
    },
  };

  const requireAdmin = (req, res, next) => {
    if (!adminLogado) return res.status(401).json({ error: 'admin_required' });
    req.admin = { uid: 'adm', name: 'Admin' };
    next();
  };

  const rotas = criarRotasRelatos({
    relatos,
    verifyToken,
    salas,
    eventos,
    pessoa,
    requireAdmin,
    publicOrigin: ORIGEM,
    webhookUrl: () => 'https://discord.com/api/webhooks/1/abc',
    enviar,
    limites: { porUid: 5, porIp: 1000, janelaMs: 600_000 },
  });

  const app = express();
  app.use('/api/relatos', rotas.publicas);
  app.use(express.json());
  app.use('/api/admin', rotas.admin);
  server = createServer(app);
  await new Promise((pronto) => server.listen(0, '127.0.0.1', pronto));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((pronto) => server.close(pronto));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  adminLogado = true;
  enviar.mockClear();
  encerrarChamadas.length = 0;
});

const tokenDe = (extra = {}) =>
  signToken({ room: 'sala1', uid: `quem-${++seq}`, name: 'Quem', role: 'viewer', ...extra });

const post = (caminho, corpo, headers = {}) =>
  fetch(`${url}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(corpo),
  });

const bug = (extra = {}) => ({
  token: tokenDe(),
  origem: 'atividade',
  texto: 'A transmissão congela a cada minuto',
  ...extra,
});

const denuncia = (extra = {}) => ({
  token: tokenDe(),
  slot: 0,
  categoria: 'golpe',
  texto: 'pede dinheiro',
  prints: [],
  ...extra,
});

describe('POST /api/relatos/bug', () => {
  it('salva o relato, devolve o id e avisa o webhook', async () => {
    const r = await post('/api/relatos/bug', bug({ contexto: { versao: '1', navegador: 'x' } }));
    const corpo = await r.json();

    expect(r.status).toBe(200);
    expect(corpo.ok).toBe(true);
    const salvo = relatos.ler(corpo.id);
    expect(salvo).toMatchObject({
      tipo: 'bug',
      origem: 'atividade',
      contexto: { versao: '1' },
      sala: { id: 'sala1', nome: 'Sala de teste' },
    });
    expect(salvo.servidor.sala).toMatchObject({ id: 'sala1', viewers: 2, controles: 0 });
    expect(salvo.servidor.sala.broadcasters).toHaveLength(3);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0][1].allowed_mentions).toEqual({ parse: [] });
  });

  it('sem token válido: 401; token de identidade não serve', async () => {
    expect((await post('/api/relatos/bug', bug({ token: 'lixo' }))).status).toBe(401);
    expect((await post('/api/relatos/bug', bug({ token: undefined }))).status).toBe(401);
    const semUid = signToken({ room: 'sala1' });
    expect((await post('/api/relatos/bug', bug({ token: semUid }))).status).toBe(401);
    const identidade = signToken({ scope: 'identity', uid: 'x', name: 'x' }, 60);
    expect((await post('/api/relatos/bug', bug({ token: identidade }))).status).toBe(401);
  });

  it('aceita token de broadcaster, da aba de captura', async () => {
    const r = await post(
      '/api/relatos/bug',
      bug({ token: tokenDe({ role: 'broadcaster' }), origem: 'captura' }),
    );
    expect(r.status).toBe(200);
  });

  it('valida origem e tamanho do texto com mensagem em português', async () => {
    for (const ruim of [
      bug({ origem: 'outra' }),
      bug({ texto: 'curto' }),
      bug({ texto: '          ' }),
      bug({ texto: 'a'.repeat(2001) }),
      bug({ texto: 42 }),
    ]) {
      const r = await post('/api/relatos/bug', ruim);
      expect(r.status).toBe(400);
      expect(typeof (await r.json()).error).toBe('string');
    }
  });

  it('recusa contexto que não é objeto ou passa de 200KB', async () => {
    expect((await post('/api/relatos/bug', bug({ contexto: 'texto' }))).status).toBe(400);
    expect((await post('/api/relatos/bug', bug({ contexto: [1] }))).status).toBe(400);
    const grande = { lixo: 'a'.repeat(210_000) };
    expect((await post('/api/relatos/bug', bug({ contexto: grande }))).status).toBe(400);
  });

  it('remove chaves sensíveis do contexto, em qualquer nível', async () => {
    const r = await post(
      '/api/relatos/bug',
      bug({
        contexto: {
          ok: 1,
          token: 'a',
          aninhado: { Authorization: 'b', lista: [{ senha: 'c', bom: 2 }] },
        },
      }),
    );
    const salvo = relatos.ler((await r.json()).id);
    expect(salvo.contexto).toEqual({ ok: 1, aninhado: { lista: [{ bom: 2 }] } });
  });

  it('anexa só os eventos da sala ou da pessoa que relatou', async () => {
    eventos.registrar('viewer.connect', { sala: 'sala1', pessoa: 'p-x' });
    eventos.registrar('viewer.connect', { sala: 'outra', pessoa: 'p-y' });
    eventos.registrar('control.connect', { sala: 'outra', pessoa: 'p-evt' });

    const r = await post('/api/relatos/bug', bug({ token: tokenDe({ uid: 'evt' }) }));
    const { servidor } = relatos.ler((await r.json()).id);

    expect(servidor.eventos.map((e) => e.event)).toEqual(['viewer.connect', 'control.connect']);
    expect(servidor.eventos[1].data.pessoa).toBe('p-evt');
  });

  it('limita 5 relatos por pessoa e responde 429, sem contar os recusados', async () => {
    const token = tokenDe({ uid: 'spam' });
    await post('/api/relatos/bug', bug({ token, texto: 'curto' })); // 400, não conta
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/relatos/bug', bug({ token }))).status).toBe(200);
    }
    const r = await post('/api/relatos/bug', bug({ token }));
    expect(r.status).toBe(429);
    expect(typeof (await r.json()).error).toBe('string');
    // A denúncia divide a mesma cota.
    expect((await post('/api/relatos/denuncia', denuncia({ token }))).status).toBe(429);
  });
});

describe('limite por IP', () => {
  it('responde 429 quando o mesmo IP passa do teto, mesmo com pessoas diferentes', async () => {
    const rotas = criarRotasRelatos({
      relatos,
      verifyToken,
      salas,
      eventos,
      pessoa,
      requireAdmin: (_req, _res, next) => next(),
      publicOrigin: ORIGEM,
      webhookUrl: () => '',
      limites: { porUid: 5, porIp: 3, janelaMs: 600_000 },
    });
    const app = express();
    app.use('/api/relatos', rotas.publicas);
    const srv = createServer(app);
    await new Promise((pronto) => srv.listen(0, '127.0.0.1', pronto));
    const alvo = `http://127.0.0.1:${srv.address().port}/api/relatos/bug`;
    const enviarBug = () =>
      fetch(alvo, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bug()),
      });

    try {
      for (let i = 0; i < 3; i++) expect((await enviarBug()).status).toBe(200);
      expect((await enviarBug()).status).toBe(429);
    } finally {
      await new Promise((pronto) => srv.close(pronto));
    }
  });
});

describe('POST /api/relatos/denuncia', () => {
  it('salva com o alvo, o retrato da sala e os prints JPEG', async () => {
    const r = await post('/api/relatos/denuncia', denuncia({ prints: [printJpeg(), printJpeg()] }));
    const corpo = await r.json();

    expect(r.status).toBe(200);
    const salvo = relatos.ler(corpo.id);
    expect(salvo).toMatchObject({
      tipo: 'denuncia',
      categoria: 'golpe',
      urgente: false,
      prints: 2,
      alvo: { uid: 'alvo-1', nome: 'Alvo', fonte: 'tela' },
    });
    expect(salvo.alvo.transmitindoHaS).toBeGreaterThanOrEqual(60);
    expect(salvo.servidor.sala.id).toBe('sala1');
    expect(relatos.caminhoPrint(corpo.id, 2)).not.toBeNull();
    expect(enviar.mock.calls[0][2]).toHaveLength(2);
  });

  it('exige viewer: token de broadcaster é 401', async () => {
    const r = await post(
      '/api/relatos/denuncia',
      denuncia({ token: tokenDe({ role: 'broadcaster' }) }),
    );
    expect(r.status).toBe(401);
  });

  it('404 para slot inexistente, parado ou de sala que não existe mais', async () => {
    expect((await post('/api/relatos/denuncia', denuncia({ slot: 9 }))).status).toBe(404);
    expect((await post('/api/relatos/denuncia', denuncia({ slot: 2 }))).status).toBe(404);
    expect((await post('/api/relatos/denuncia', denuncia({ slot: '0' }))).status).toBe(404);
    const outraSala = tokenDe({ room: 'sumiu' });
    expect((await post('/api/relatos/denuncia', denuncia({ token: outraSala }))).status).toBe(404);
  });

  it('400 ao denunciar a própria transmissão', async () => {
    const token = tokenDe({ uid: 'quem-1' });
    expect((await post('/api/relatos/denuncia', denuncia({ token, slot: 1 }))).status).toBe(400);
  });

  it('valida categoria e texto', async () => {
    for (const ruim of [
      denuncia({ categoria: 'nada' }),
      denuncia({ categoria: undefined }),
      denuncia({ texto: 'a'.repeat(1001) }),
      denuncia({ categoria: 'outro', texto: 'oi' }),
      denuncia({ categoria: 'outro', texto: '' }),
    ]) {
      const r = await post('/api/relatos/denuncia', ruim);
      expect(r.status).toBe(400);
      expect(typeof (await r.json()).error).toBe('string');
    }
    expect((await post('/api/relatos/denuncia', denuncia({ texto: '' }))).status).toBe(200);
    expect(
      (await post('/api/relatos/denuncia', denuncia({ categoria: 'outro', texto: 'motivo' })))
        .status,
    ).toBe(200);
  });

  it('descarta print inválido sem derrubar a denúncia', async () => {
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;
    const falsoJpeg = `data:image/jpeg;base64,${Buffer.from('nao sou jpeg').toString('base64')}`;
    const grande = printJpeg(401 * 1024);
    const r = await post(
      '/api/relatos/denuncia',
      denuncia({ prints: [printJpeg(), png, falsoJpeg, grande, 42, null] }),
    );
    const salvo = relatos.ler((await r.json()).id);

    expect(r.status).toBe(200);
    expect(salvo.prints).toBe(1);
  });

  it('guarda no máximo 4 prints', async () => {
    const prints = Array.from({ length: 6 }, () => printJpeg());
    const r = await post('/api/relatos/denuncia', denuncia({ prints }));
    expect(relatos.ler((await r.json()).id).prints).toBe(4);
  });

  it('aceita corpo de vários MB (limite próprio da rota)', async () => {
    const prints = Array.from({ length: 4 }, () => printJpeg(390 * 1024));
    const r = await post('/api/relatos/denuncia', denuncia({ prints }));
    expect(r.status).toBe(200);
    expect(relatos.ler((await r.json()).id).prints).toBe(4);
  });

  it('menores: descarta todos os prints, marca urgente e não envia imagem', async () => {
    const r = await post(
      '/api/relatos/denuncia',
      denuncia({ categoria: 'menores', prints: [printJpeg(), printJpeg()] }),
    );
    const { id } = await r.json();
    const salvo = relatos.ler(id);

    expect(r.status).toBe(200);
    expect(salvo).toMatchObject({ categoria: 'menores', urgente: true, prints: 0 });
    expect(relatos.caminhoPrint(id, 1)).toBeNull();
    expect(fs.readdirSync(path.join(base, 'relatos', id))).toEqual(['relato.json']);
    expect(enviar.mock.calls[0][2]).toEqual([]);
    expect(enviar.mock.calls[0][1].embeds[0].title).toMatch(/URGENTE/);
  });

  it('413 em JSON, com {error}, quando o corpo passa de 3MB', async () => {
    const r = await post(
      '/api/relatos/denuncia',
      denuncia({ prints: ['a'.repeat(3.2 * 1024 * 1024)] }),
    );
    expect(r.status).toBe(413);
    expect(typeof (await r.json()).error).toBe('string');
  });
});

describe('funções auxiliares', () => {
  it('decodificarPrint confere os bytes do JPEG e o tamanho', () => {
    expect(decodificarPrint(printJpeg())).toBeInstanceOf(Buffer);
    expect(decodificarPrint('data:image/jpeg;base64,@@@')).toBeNull();
    expect(decodificarPrint(printJpeg(401 * 1024))).toBeNull();
    expect(decodificarPrint('data:image/jpeg;base64,')).toBeNull();
  });

  it('limparContexto ignora __proto__ e corta recursão', () => {
    const limpo = limparContexto(JSON.parse('{"__proto__":{"x":1},"a":1}'));
    expect(Object.getPrototypeOf(limpo)).toBe(Object.prototype);
    expect(limpo).toEqual({ a: 1 });

    let fundo = { fim: 1 };
    for (let i = 0; i < 100; i++) fundo = { n: fundo };
    expect(JSON.stringify(limparContexto(fundo))).toContain('[LIMITE]');
  });
});

describe('rotas do admin', () => {
  const comOrigem = { Origin: ORIGEM };
  let idBug;

  beforeAll(async () => {
    adminLogado = true;
    idBug = relatos.salvar('bug', { texto: 'para o admin', origem: 'atividade' });
    relatos.salvar('denuncia', { texto: 'x', categoria: 'golpe' }, [
      Buffer.from([0xff, 0xd8, 0xff, 1]),
    ]);
  });

  it('GET exige sessão de admin', async () => {
    adminLogado = false;
    const alvos = [
      '/api/admin/relatos',
      `/api/admin/relatos/${idBug}`,
      `/api/admin/relatos/${idBug}/print/1`,
      '/api/admin/moderacao/bloqueios',
    ];
    for (const alvo of alvos) expect((await fetch(url + alvo)).status).toBe(401);
  });

  it('POST exige sessão (401) e depois a origem do painel (403)', async () => {
    const acoes = [
      [`/api/admin/relatos/${idBug}/resolver`, { nota: 'ok' }],
      ['/api/admin/moderacao/encerrar', { uid: 'alvo-1' }],
      ['/api/admin/moderacao/bloquear', { uid: 'alvo-1' }],
      ['/api/admin/moderacao/desbloquear', { uid: 'alvo-1' }],
    ];
    for (const [caminho, corpo] of acoes) {
      adminLogado = false;
      expect((await post(caminho, corpo, comOrigem)).status).toBe(401);
      adminLogado = true;
      expect((await post(caminho, corpo)).status).toBe(403);
      expect((await post(caminho, corpo, { Origin: 'https://evil.test' })).status).toBe(403);
      expect((await post(caminho, corpo, { Origin: 'nao-e-url' })).status).toBe(403);
    }
    expect(encerrarChamadas).toEqual([]);
    expect(relatos.ler(idBug).status).toBe('aberto');
    expect(relatos.estaBloqueado('alvo-1')).toBe(false);
  });

  it('aceita origem local mesmo com PUBLIC_ORIGIN público', async () => {
    const r = await post(
      '/api/admin/moderacao/desbloquear',
      { uid: 'z' },
      { Origin: 'http://localhost:3001' },
    );
    expect(r.status).toBe(200);
  });

  it('lista com filtros, lê o detalhe e serve o print como jpeg sem cache', async () => {
    const lista = await (
      await fetch(`${url}/api/admin/relatos?tipo=denuncia&status=aberto`)
    ).json();
    expect(lista.relatos.length).toBeGreaterThan(0);
    expect(lista.relatos.every((x) => x.tipo === 'denuncia' && x.status === 'aberto')).toBe(true);

    expect((await fetch(`${url}/api/admin/relatos/${idBug}`)).status).toBe(200);
    expect((await fetch(`${url}/api/admin/relatos/..%2F..%2Fx`)).status).toBe(404);

    const comPrint = lista.relatos.find((x) => x.prints > 0);
    const imagem = await fetch(`${url}/api/admin/relatos/${comPrint.id}/print/1`);
    expect(imagem.status).toBe(200);
    expect(imagem.headers.get('content-type')).toBe('image/jpeg');
    expect(imagem.headers.get('cache-control')).toBe('no-store');
    expect((await imagem.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await fetch(`${url}/api/admin/relatos/${comPrint.id}/print/7`)).status).toBe(404);
  });

  it('resolve um relato com nota; 404 para id inexistente', async () => {
    const r = await post(`/api/admin/relatos/${idBug}/resolver`, { nota: 'feito' }, comOrigem);
    expect(r.status).toBe(200);
    expect(relatos.ler(idBug)).toMatchObject({
      status: 'resolvido',
      resolucao: { nota: 'feito', por: 'Admin' },
    });

    const nao = await post('/api/admin/relatos/20200101-000000-0000/resolver', {}, comOrigem);
    expect(nao.status).toBe(404);
  });

  it('encerra as transmissões da pessoa e diz quantas', async () => {
    const r = await post('/api/admin/moderacao/encerrar', { uid: 'alvo-1' }, comOrigem);

    expect(await r.json()).toEqual({ ok: true, encerradas: 1 });
    expect(encerrarChamadas).toEqual([
      {
        uid: 'alvo-1',
        motivo: 'Sua transmissão foi encerrada pela moderação.',
        origem: 'moderacao',
      },
    ]);
    expect((await post('/api/admin/moderacao/encerrar', { uid: 5 }, comOrigem)).status).toBe(400);
  });

  it('bloqueia (encerrando o que está no ar), lista e desbloqueia', async () => {
    const r = await post(
      '/api/admin/moderacao/bloquear',
      { uid: 'alvo-1', nome: 'Alvo', motivo: 'golpe' },
      comOrigem,
    );
    expect(await r.json()).toEqual({ ok: true, encerradas: 1 });
    expect(relatos.estaBloqueado('alvo-1')).toBe(true);

    const lista = await (await fetch(`${url}/api/admin/moderacao/bloqueios`)).json();
    expect(lista.bloqueios).toMatchObject([
      { uid: 'alvo-1', nome: 'Alvo', motivo: 'golpe', por: 'Admin' },
    ]);

    await post('/api/admin/moderacao/desbloquear', { uid: 'alvo-1' }, comOrigem);
    expect(relatos.estaBloqueado('alvo-1')).toBe(false);
  });
});
