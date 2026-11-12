/**
 * O servidor visto de fora da máquina: PUBLIC_ORIGIN público e NODE_ENV
 * diferente de production (o caso de quem subiu sem configurar o ambiente).
 *
 * Arquivo separado porque a decisão sobre a rota de identidade de teste é
 * tomada no corpo do módulo, uma vez. Também cobre o sinal de vida (`hb`) e a
 * rota de saída sem token, que compartilham este mesmo servidor.
 */
import http from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

process.env.PUBLIC_ORIGIN = 'https://exemplo.test';
// Intervalo curto só para o teste não esperar os 10s reais.
process.env.HB_INTERVAL_MS = '100';

const avisos = [];
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation((...args) => avisos.push(args.join(' ')));
vi.spyOn(console, 'error').mockImplementation(() => {});

const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
const R = await import('./rooms.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const porta = server.address().port;
const base = `http://127.0.0.1:${porta}`;

const post = (caminho, corpo) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
  });

afterAll(async () => {
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('/api/session-dev com endereço público', () => {
  it('responde 404 mesmo fora de production', async () => {
    expect((await post('/api/session-dev', { name: 'Intruso' })).status).toBe(404);
  });

  it('avisa no arranque que o servidor está exposto em modo desenvolvimento', () => {
    expect(avisos.some((a) => a.includes('NODE_ENV=production'))).toBe(true);
  });
});

describe('/api/rooms/leave sem token', () => {
  it('responde 401 uma única vez, sem estourar ERR_HTTP_HEADERS_SENT', async () => {
    const erros = [];
    const original = http.ServerResponse.prototype.setHeader;
    const espia = vi.spyOn(http.ServerResponse.prototype, 'setHeader').mockImplementation(function (
      ...args
    ) {
      try {
        return original.apply(this, args);
      } catch (err) {
        erros.push(err);
        throw err;
      }
    });

    try {
      const res = await post('/api/rooms/leave', { roomId: 'inexistente' });
      expect(res.status).toBe(401);
    } finally {
      espia.mockRestore();
    }

    expect(erros.filter((e) => e.code === 'ERR_HTTP_HEADERS_SENT')).toHaveLength(0);
  });
});

describe('sinal de vida de aplicação', () => {
  it('entrega {"type":"hb"} a quem está conectado', async () => {
    const { room } = R.createRoom({
      instance: 'hb',
      name: 'Sala',
      ownerId: 'dono',
      ownerName: 'D',
    });
    const token = signToken({ room: room.id, uid: 'u-hb', name: 'Hb', av: null, role: 'viewer' });
    const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws?t=${encodeURIComponent(token)}`);
    const hb = new Promise((resolve, reject) => {
      const prazo = setTimeout(() => reject(new Error('hb não chegou')), 3000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'hb') return;
        clearTimeout(prazo);
        resolve(msg);
      });
      ws.once('error', reject);
    });

    expect(await hb).toEqual({ type: 'hb' });
    ws.close();
  });
});
