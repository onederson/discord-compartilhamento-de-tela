import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@discord/embedded-app-sdk', () => ({
  Common: { OrientationLockStateTypeObject: { LANDSCAPE: 3, UNLOCKED: 1 } },
  DiscordSDK: class {},
}));

vi.mock('./player.js', () => ({
  createPlayer: () => ({
    start: () => true,
    stop: vi.fn(),
    push: vi.fn(),
    getLag: () => 24,
    takeFrameCount: () => 30,
    getSizes: () => ({ video: '1280×720', box: '640×360' }),
  }),
}));

vi.mock('./audio.js', () => ({
  createAudio: () => ({ start: () => true, stop: vi.fn(), setVolume: vi.fn(), temSom: () => true }),
}));

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const salas = [
  { id: 'sala-a', name: 'Sala A', owner: 'Ana', people: 1, streams: 1 },
  { id: 'sala-b', name: 'Sala B', owner: 'Bruno', people: 1, streams: 0 },
];
const config = { codec: 'vp8', codedWidth: 1280, codedHeight: 720 };
const sockets = [];
let dom;

class SocketFalso {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = SocketFalso.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    sockets.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    if (type === 'open') this.readyState = SocketFalso.OPEN;
    if (type === 'close') this.readyState = SocketFalso.CLOSED;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, code: 1006, reason: '', ...event });
    }
  }

  message(data) {
    this.dispatch('message', { data: JSON.stringify(data) });
  }

  send(data) {
    if (this.readyState !== SocketFalso.OPEN) throw new Error('Socket não está aberto');
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = SocketFalso.CLOSING;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tokens = (id) => ({
  roomId: id,
  viewerToken: `viewer-${id}`,
  shareUrl: 'http://localhost/share.html?t=teste',
});

function estado({ userId = 'ana', fonte = 'tela', roomId = 'sala-a' } = {}) {
  return {
    type: 'state',
    room: { id: roomId, name: salas.find((s) => s.id === roomId)?.name, ownerId: userId },
    participants: [
      { id: 'guest-visitante', name: 'Visitante', broadcasting: false },
      { id: userId, name: userId === 'ana' ? 'Ana' : 'Bruno', broadcasting: true },
    ],
    streams: [{ slot: 0, userId, fonte, watchers: [] }],
  };
}

async function entrar(indice = 0) {
  const quantidade = sockets.length;
  document.querySelectorAll('.room-card')[indice].click();
  await vi.waitFor(() => expect(sockets).toHaveLength(quantidade + 1));
  const socket = sockets.at(-1);
  socket.dispatch('open');
  return socket;
}

function anunciar(socket, opcoes = {}) {
  socket.message(estado(opcoes));
  socket.message({
    type: 'stream-start',
    slot: 0,
    userId: opcoes.userId ?? 'ana',
    fonte: opcoes.fonte ?? 'tela',
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  sockets.length = 0;
  dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'localStorage',
    'screen',
    'HTMLElement',
    'MutationObserver',
  ]) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
  vi.stubGlobal('WebSocket', SocketFalso);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      postMessage() {}
      close() {}
    },
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const identity = `${Buffer.from(JSON.stringify({ uid: 'guest-visitante', name: 'Visitante' })).toString('base64url')}.assinatura`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const pathname = new URL(String(url), 'http://localhost').pathname;
      const body = JSON.parse(init?.body ?? '{}');
      if (pathname === '/api/config') return json({ clientId: null, permitirWeb: true });
      if (pathname === '/api/session-guest') return json({ identity });
      if (pathname === '/api/rooms/list') return json({ rooms: salas });
      if (pathname === '/api/rooms/join') return json(tokens(body.roomId));
      if (pathname === '/api/rooms/open') return json({ ...tokens('sala-a'), name: 'Sala A' });
      if (pathname === '/api/logs') return json({ ok: true });
      throw new Error(`Pedido inesperado: ${pathname}`);
    }),
  );
  await import('./main.js');
  await vi.waitFor(() => expect(document.querySelectorAll('.room-card')).toHaveLength(2));
});

afterEach(() => {
  vi.clearAllTimers();
  dom?.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('navegação por teclado', () => {
  it('mantém o foco no modal e devolve ao botão que o abriu', () => {
    const abrir = document.getElementById('newRoom');
    abrir.focus();
    abrir.click();
    const primeiro = document.getElementById('createName');
    const ultimo = document.getElementById('createGo');
    expect(document.activeElement).toBe(primeiro);
    primeiro.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(ultimo);
    ultimo.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(primeiro);
    document.getElementById('createCancel').click();
    expect(document.activeElement).toBe(abrir);
    expect(document.getElementById('lobby').inert).toBe(false);
  });

  it('seleciona o perfil de qualidade com as setas e mantém uma única parada de Tab', async () => {
    await entrar();
    document.getElementById('quality').click();
    const atual = document.querySelector('[data-quality="equilibrado"]');
    atual.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    const proximo = document.querySelector('[data-quality="nitido"]');
    expect(document.activeElement).toBe(proximo);
    expect(proximo.getAttribute('aria-checked')).toBe('true');
    expect(proximo.tabIndex).toBe(0);
    expect(atual.tabIndex).toBe(-1);
  });
});

describe('diagnóstico da sala', () => {
  it('mostra o estado real da conexão e abre os detalhes sem interromper a sala', async () => {
    const socket = await entrar();
    anunciar(socket);
    const botao = document.getElementById('connectionPill');
    expect(botao).not.toBeNull();
    expect(botao.dataset.state).toBe('connected');
    botao.click();
    expect(document.getElementById('panel').hidden).toBe(false);
    expect(botao.getAttribute('aria-expanded')).toBe('true');

    socket.dispatch('close');
    expect(botao.dataset.state).toBe('reconnecting');
    expect(document.getElementById('connectionText').textContent).toBe('Reconectando');
  });

  it('copia somente métricas técnicas, sem nomes, tokens ou endereços', async () => {
    const socket = await entrar();
    anunciar(socket);
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    await vi.advanceTimersByTimeAsync(1000);
    const copiar = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copiar },
      configurable: true,
    });
    document.getElementById('connectionPill').click();
    document.getElementById('copyDiagnostics').click();
    await vi.waitFor(() => expect(copiar).toHaveBeenCalledOnce());

    const texto = copiar.mock.calls[0][0];
    const resumo = JSON.parse(texto);
    expect(resumo.connection).toBe('connected');
    expect(resumo.streams).toEqual([
      expect.objectContaining({ source: 'tela', codec: 'vp8', fps: 30, resolution: '1280×720' }),
    ]);
    for (const privado of [
      'Ana',
      'guest-visitante',
      'viewer-sala-a',
      'http://',
      'identity',
      'shareUrl',
    ]) {
      expect(texto).not.toContain(privado);
    }
  });

  it('permite pedir um novo quadro sem refazer a captura', async () => {
    const socket = await entrar();
    anunciar(socket);
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    const antes = socket.sent.filter((m) => m.type === 'watch').length;
    document.getElementById('connectionPill').click();
    document.getElementById('recoverStreams').click();

    expect(socket.sent.filter((m) => m.type === 'watch')).toHaveLength(antes + 1);
    expect(socket.readyState).toBe(SocketFalso.OPEN);
    expect(document.querySelector('.tile-palco canvas')).not.toBeNull();
  });
});

describe('continuidade de quem assiste', () => {
  it('não deixa o diagnóstico lançar outro erro ao receber objetos circulares', () => {
    const circular = {};
    circular.self = circular;

    expect(() => console.error(new Error('Falha de exemplo'), circular, 10n)).not.toThrow();
    const chamada = fetch.mock.calls.find(([url]) => url === '/api/logs');
    expect(JSON.parse(chamada[1].body).message).toContain('Falha de exemplo');
  });

  it('envia o token correto da sala ao encerrar a Activity', async () => {
    await entrar();
    navigator.sendBeacon = vi.fn(() => true);
    window.dispatchEvent(new window.Event('pagehide'));

    const [url, body] = navigator.sendBeacon.mock.calls[0];
    expect(url).toBe('/api/rooms/leave');
    expect(JSON.parse(await body.text()).token).toBe('viewer-sala-a');
  });

  it('encerra uma tentativa de conexão que nunca completa o handshake', async () => {
    document.querySelector('.room-card').click();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets[0].readyState).toBe(SocketFalso.CLOSING);
  });

  it.each([401, 404])(
    'abandona a sessão somente quando o HTTP confirma a recusa %i',
    async (status) => {
      document.querySelector('.room-card').click();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      fetch.mockResolvedValueOnce(json({ error: 'Acesso recusado' }, status));
      sockets[0].dispatch('close');
      await vi.advanceTimersByTimeAsync(1000);

      expect(document.getElementById('lobby').hidden).toBe(false);
      expect(localStorage.getItem('sala:sala-a')).toBeNull();
      expect(sockets).toHaveLength(1);
    },
  );

  it('ignora mensagens inválidas sem quebrar a página', async () => {
    const socket = await entrar();
    for (const data of ['{', 'null', '[]', new ArrayBuffer(0)]) {
      expect(() => socket.dispatch('message', { data })).not.toThrow();
    }
    anunciar(socket);
    expect(document.getElementById('grid').hidden).toBe(false);
  });

  it('cancela a reconexão pendente ao sair e entrar em outra sala', async () => {
    const antigo = await entrar();
    anunciar(antigo);
    antigo.dispatch('close');
    document.getElementById('leaveRoom').click();
    const atual = await entrar(1);
    anunciar(atual, { roomId: 'sala-b', userId: 'bruno' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(2);
    expect(atual.readyState).toBe(SocketFalso.OPEN);
    expect(document.getElementById('roomPill').textContent).toBe('Sala B');
  });

  it.each(['close', 'error', 'message'])(
    'ignora o evento %s de uma conexão de outra sala',
    async (evento) => {
      const antigo = await entrar();
      anunciar(antigo);
      document.getElementById('leaveRoom').click();
      const atual = await entrar(1);
      anunciar(atual, { roomId: 'sala-b', userId: 'bruno' });

      antigo.dispatch(evento, { data: JSON.stringify(estado()) });
      await vi.advanceTimersByTimeAsync(1000);

      expect(atual.readyState).toBe(SocketFalso.OPEN);
      expect(sockets).toHaveLength(2);
      expect(document.getElementById('roomPill').textContent).toBe('Sala B');
      expect(document.getElementById('grid').hidden).toBe(false);
    },
  );

  it('não confunde uma queda de rede antes da abertura com uma sessão expirada', async () => {
    document.querySelector('.room-card').click();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    sockets[0].dispatch('close');
    await vi.advanceTimersByTimeAsync(1000);

    expect(new URL(location.href).searchParams.get('sala')).toBe('sala-a');
    expect(document.getElementById('lobby').hidden).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it.each([{ userId: 'bruno' }, { fonte: 'camera' }])(
    'não reassiste sem consentimento se um slot foi reutilizado: %j',
    async (mudanca) => {
      const primeiro = await entrar();
      anunciar(primeiro);
      document.querySelector('.watch-prompt button').click();
      primeiro.message({ type: 'config', slot: 0, config });

      primeiro.dispatch('close');
      await vi.advanceTimersByTimeAsync(1000);
      const segundo = sockets.at(-1);
      segundo.dispatch('open');
      anunciar(segundo, mudanca);
      segundo.message({ type: 'config', slot: 0, config });

      expect(segundo.sent).not.toContainEqual({ type: 'watch', slot: 0 });
      expect(document.querySelector('.tile-palco .watch-prompt')).not.toBeNull();
    },
  );

  it('retoma a tela escolhida quando o relay reanuncia a transmissão após reconectar', async () => {
    const primeiro = await entrar();
    anunciar(primeiro);
    document.querySelector('.watch-prompt button').click();
    primeiro.message({ type: 'config', slot: 0, config });
    expect(document.querySelector('.tile-palco canvas')).not.toBeNull();

    primeiro.dispatch('close');
    await vi.advanceTimersByTimeAsync(1000);
    const segundo = sockets.at(-1);
    expect(segundo).not.toBe(primeiro);
    segundo.dispatch('open');
    anunciar(segundo);
    segundo.message({ type: 'config', slot: 0, config });

    expect(segundo.sent).toContainEqual({ type: 'watch', slot: 0 });
    expect(document.querySelector('.tile-palco canvas')).not.toBeNull();
    expect(document.querySelector('.tile-palco .watch-prompt')).toBeNull();
  });

  it('mantém o canvas durante o grace period de queda e só limpa após expiração', async () => {
    const primeiro = await entrar();
    anunciar(primeiro);
    document.querySelector('.watch-prompt button').click();
    primeiro.message({ type: 'config', slot: 0, config });
    expect(document.querySelector('.tile-palco canvas')).not.toBeNull();

    // Queda do WebSocket
    primeiro.dispatch('close');
    expect(document.getElementById('connectionPill').dataset.state).toBe('reconnecting');

    // Durante o grace period (ex: 2s após a queda): o canvas deve continuar na tela
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.querySelector('.tile-palco canvas')).not.toBeNull();

    // Após expiração do grace period (total > 15s): a limpeza é executada
    await vi.advanceTimersByTimeAsync(14_000);
    expect(document.querySelector('.tile-palco canvas')).toBeNull();
  });
});
