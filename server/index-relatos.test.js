/**
 * Relatos e moderação no servidor de verdade: a ordem dos parsers de corpo, o
 * cookie de admin, a conferência de Origin e o bloqueio na conexão de
 * transmissão. As regras de cada rota estão em relatos-rotas.test.js.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const ADMIN = '123456789012345678';
process.env.DISCORD_ADMIN_ID = ADMIN;
process.env.PUBLIC_ORIGIN = 'https://exemplo.test';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
const R = await import('./rooms.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const porta = server.address().port;
const base = `http://127.0.0.1:${porta}`;

const cookieAdmin = `discord_screen_admin=${signToken({ scope: 'admin', uid: ADMIN, name: 'Admin' }, 3600)}`;
const comAdmin = { Cookie: cookieAdmin, Origin: 'https://exemplo.test' };

const post = (caminho, corpo, headers = {}) =>
  fetch(base + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(corpo),
  });

const room = R.createRoom({
  instance: 'rel',
  name: 'Sala',
  ownerId: 'dono',
  ownerName: 'Dono',
}).room;
const tokenDe = (uid, role) =>
  signToken({ room: room.id, uid, name: `Pessoa ${uid}`, av: null, role });

const abertos = [];
function conectar(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws?t=${encodeURIComponent(token)}`);
  ws.recebidas = [];
  ws.on('message', (data) => ws.recebidas.push(JSON.parse(data.toString())));
  abertos.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const ate = (ws, predicado) =>
  new Promise((resolve, reject) => {
    const prazo = setTimeout(() => reject(new Error('tempo esgotado')), 3000);
    const achar = () => {
      const msg = ws.recebidas.find(predicado);
      if (!msg) return false;
      clearTimeout(prazo);
      resolve(msg);
      return true;
    };
    if (!achar()) ws.on('message', () => achar());
  });

afterAll(async () => {
  for (const ws of abertos) ws.terminate();
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('admin dos relatos', () => {
  it('sem cookie de admin: 401 em leitura e em ação', async () => {
    expect((await fetch(`${base}/api/admin/relatos`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/moderacao/bloqueios`)).status).toBe(401);
    expect((await post('/api/admin/moderacao/encerrar', { uid: 'x' })).status).toBe(401);
  });

  it('com cookie mas sem Origin do painel: 403', async () => {
    const r = await post('/api/admin/moderacao/bloquear', { uid: 'x' }, { Cookie: cookieAdmin });
    expect(r.status).toBe(403);
  });
});

describe('fluxo completo', () => {
  it('uma denúncia com prints grandes chega ao painel e some do ar quando o admin bloqueia', async () => {
    // O alvo entra no ar.
    const alvo = await conectar(tokenDe('alvo-9', 'broadcaster'));
    const { slot } = await ate(alvo, (m) => m.type === 'slot');
    alvo.send(JSON.stringify({ type: 'start' }));
    await vi.waitFor(() => expect(room.slots.get(slot)?.streaming).toBe(true));

    // Corpo de ~1,6MB: passaria do limite padrão de 100kb do Express.
    const jpeg = `data:image/jpeg;base64,${Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(390 * 1024, 7),
    ]).toString('base64')}`;
    const r = await post('/api/relatos/denuncia', {
      token: tokenDe('quem-denuncia', 'viewer'),
      slot,
      categoria: 'pirataria',
      texto: 'filme inteiro',
      prints: [jpeg, jpeg, jpeg],
    });
    expect(r.status).toBe(200);
    const { id } = await r.json();

    const detalhe = await (
      await fetch(`${base}/api/admin/relatos/${id}`, { headers: comAdmin })
    ).json();
    expect(detalhe).toMatchObject({ prints: 3, alvo: { uid: 'alvo-9' } });

    // Bloquear derruba a transmissão que está no ar...
    const b = await post(
      '/api/admin/moderacao/bloquear',
      { uid: 'alvo-9', nome: 'Alvo' },
      comAdmin,
    );
    expect(await b.json()).toEqual({ ok: true, encerradas: 1 });
    const parada = await ate(alvo, (m) => m.type === 'stop-request');
    expect(parada.motivo).toBe('Sua transmissão foi encerrada pela moderação.');
    expect(room.slots.size).toBe(0);

    // ...e impede uma nova conexão de transmissão.
    const volta = await conectar(tokenDe('alvo-9', 'broadcaster'));
    const erro = await ate(volta, (m) => m.type === 'error');
    expect(erro.message).toBe('Você está bloqueado de transmitir neste servidor.');
    await new Promise((pronto) => volta.once('close', pronto));
    expect(room.slots.size).toBe(0);

    // Desbloqueado, volta a transmitir.
    await post('/api/admin/moderacao/desbloquear', { uid: 'alvo-9' }, comAdmin);
    const livre = await conectar(tokenDe('alvo-9', 'broadcaster'));
    await ate(livre, (m) => m.type === 'slot');
  });
});
