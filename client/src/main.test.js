import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@discord/embedded-app-sdk', () => ({
  Common: { OrientationLockStateTypeObject: { LANDSCAPE: 3, UNLOCKED: 1 } },
  DiscordSDK: class {},
}));

// Opções de cada player criado: os testes de print dão o "primeiro quadro" à mão.
const jogadores = vi.hoisted(() => []);

vi.mock('./player.js', () => ({
  createPlayer: (_canvas, opcoes) => ({
    start: () => {
      jogadores.push(opcoes);
      return true;
    },
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
  // Jitter da reconexão no piso (x0,8): os atrasos ficam abaixo do nominal.
  vi.spyOn(Math, 'random').mockReturnValue(0);
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

  it('descarregar o iframe não encerra a transmissão nem fecha a aba de captura', async () => {
    // O Discord recria o iframe sem a pessoa sair (overlay de jogo, reset da
    // GPU). Quem decide que ela saiu é a carência do servidor.
    const socket = await entrar();
    navigator.sendBeacon = vi.fn(() => true);
    fetch.mockClear();
    window.dispatchEvent(new window.Event('pagehide'));
    window.dispatchEvent(new window.Event('beforeunload'));

    // O único beacon permitido é o da caixa-preta, para o diagnóstico.
    expect(navigator.sendBeacon.mock.calls.map(([url]) => url)).toEqual(['/api/logs']);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/rooms/leave'))).toBe(false);
    expect(
      socket.sent.some((m) => m.type === 'close-controls-broadcast' || m.type === 'stop-broadcast'),
    ).toBe(false);
  });

  it('o arranque seguinte denuncia a atividade que morreu sem pagehide', async () => {
    // Esta página entra na sala e "morre" sem pagehide — o processo do iframe
    // derrubado, como no "Recarregar atividade" do Discord. O próximo
    // arranque acha a trilha aberta e a envia.
    const socket = await entrar();
    socket.close?.();
    window.dispatchEvent(new window.Event('blur'));
    fetch.mockClear();

    vi.resetModules();
    await import('./main.js');

    const relato = fetch.mock.calls
      .filter(([url]) => String(url).endsWith('/api/logs'))
      .map(([, init]) => JSON.parse(init.body))
      .find((b) => b.event === 'crash-suspeito');
    expect(relato).toBeDefined();
    expect(relato.details.trilha.join('\n')).toMatch(
      /sala\.entrou[\s\S]*ws\.open[\s\S]*janela\.blur/,
    );
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

describe('vigia de silêncio e retomada', () => {
  it('não arma o vigia sem hb: servidor antigo nunca é derrubado por silêncio', async () => {
    const socket = await entrar();
    anunciar(socket);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(socket.readyState).toBe(SocketFalso.OPEN);
    expect(sockets).toHaveLength(1);
  });

  it('com hb, 25s sem nenhuma mensagem derrubam o socket e reconectam', async () => {
    const socket = await entrar();
    socket.message({ type: 'hb' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.readyState).toBe(SocketFalso.CLOSING);
    expect(document.getElementById('connectionPill').dataset.state).toBe('reconnecting');

    // O close real, tardio, não pode processar a queda duas vezes.
    socket.dispatch('close');
    await vi.advanceTimersByTimeAsync(1500);
    expect(sockets).toHaveLength(2);
  });

  it('qualquer mensagem, mesmo binária, renova o prazo do silêncio', async () => {
    const socket = await entrar();
    socket.message({ type: 'hb' });
    await vi.advanceTimersByTimeAsync(20_000);
    socket.dispatch('message', { data: new ArrayBuffer(4) });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(socket.readyState).toBe(SocketFalso.OPEN);
  });

  async function assistirAna() {
    const socket = await entrar();
    anunciar(socket);
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    return socket;
  }

  it('retoma sozinho quando a mesma pessoa volta em outro slot', async () => {
    const socket = await assistirAna();
    socket.message({ type: 'stream-stop', slot: 0 });
    socket.sent.length = 0;

    socket.message({ type: 'stream-start', slot: 1, userId: 'ana', fonte: 'tela' });

    expect(socket.sent).toContainEqual({ type: 'watch', slot: 1 });
  });

  it('não retoma depois de parar de assistir de propósito', async () => {
    const socket = await assistirAna();
    document.querySelector('.tile-stop').click();
    expect(socket.sent).toContainEqual({ type: 'unwatch', slot: 0 });

    socket.message({ type: 'stream-stop', slot: 0 });
    socket.sent.length = 0;
    socket.message({ type: 'stream-start', slot: 1, userId: 'ana', fonte: 'tela' });

    expect(socket.sent.some((m) => m.type === 'watch')).toBe(false);
  });

  it('não retoma depois de 120s', async () => {
    const socket = await assistirAna();
    socket.message({ type: 'stream-stop', slot: 0 });
    await vi.advanceTimersByTimeAsync(121_000);
    socket.sent.length = 0;

    socket.message({ type: 'stream-start', slot: 1, userId: 'ana', fonte: 'tela' });

    expect(socket.sent.some((m) => m.type === 'watch')).toBe(false);
  });
});

describe('diagnóstico enviado ao servidor', () => {
  const diagnosticos = (socket, evento) =>
    socket.sent.filter((m) => m.type === 'diagnostic' && m.event === evento);

  async function assistirAna() {
    const socket = await entrar();
    anunciar(socket);
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    return socket;
  }

  const definirVisibilidade = (estado) => {
    Object.defineProperty(document, 'visibilityState', { value: estado, configurable: true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  };

  it('anuncia o arranque ao abrir o socket e marca a reconexão seguinte', async () => {
    const primeiro = await entrar();
    expect(diagnosticos(primeiro, 'viewer-arranque')[0].dados).toMatchObject({
      discord: false,
      reconexao: false,
    });

    primeiro.dispatch('close');
    await vi.advanceTimersByTimeAsync(1500);
    sockets.at(-1).dispatch('open');

    expect(diagnosticos(sockets.at(-1), 'viewer-arranque')[0].dados.reconexao).toBe(true);
  });

  it('guarda o evento gerado com o socket morto e o envia quando ele reabre', async () => {
    const socket = await entrar();
    socket.message({ type: 'hb' });
    await vi.advanceTimersByTimeAsync(25_000);
    socket.dispatch('close');
    await vi.advanceTimersByTimeAsync(1500);
    const novo = sockets.at(-1);
    expect(novo).not.toBe(socket);
    expect(diagnosticos(socket, 'viewer-silencio')).toHaveLength(0);

    novo.dispatch('open');

    const [silencio] = diagnosticos(novo, 'viewer-silencio');
    expect(silencio.dados.ms).toBeGreaterThanOrEqual(25_000);
    // A fila sai antes do arranque da nova conexão.
    expect(novo.sent.findIndex((m) => m.event === 'viewer-silencio')).toBeLessThan(
      novo.sent.findIndex((m) => m.event === 'viewer-arranque'),
    );
  });

  it('a fila offline guarda no máximo 20 eventos, descartando os mais antigos', async () => {
    const socket = await assistirAna();
    socket.dispatch('close');
    for (let i = 0; i < 25; i++) {
      Object.defineProperty(window, 'innerWidth', { value: 100 + i, configurable: true });
      definirVisibilidade(i % 2 ? 'visible' : 'hidden');
    }
    await vi.advanceTimersByTimeAsync(1500);
    const novo = sockets.at(-1);
    novo.dispatch('open');

    const visibilidade = diagnosticos(novo, 'viewer-visibilidade');
    expect(visibilidade).toHaveLength(20);
    expect(visibilidade[0].dados.w).toBe(105);
    expect(visibilidade.at(-1).dados.w).toBe(124);
  });

  it('informa a visibilidade com o tempo que ficou oculto ao voltar', async () => {
    const socket = await assistirAna();

    definirVisibilidade('hidden');
    await vi.advanceTimersByTimeAsync(4000);
    definirVisibilidade('visible');

    const [oculta, visivel] = diagnosticos(socket, 'viewer-visibilidade');
    expect(oculta.dados).toMatchObject({ estado: 'hidden', streams: 1 });
    expect(oculta.dados).not.toHaveProperty('ocultoMs');
    expect(visivel.dados).toMatchObject({ estado: 'visible', streams: 1, ocultoMs: 4000 });
  });

  it('não informa visibilidade nem tamanho sem nenhuma transmissão assistida', async () => {
    const socket = await entrar();

    definirVisibilidade('hidden');
    window.dispatchEvent(new dom.window.Event('resize'));
    await vi.advanceTimersByTimeAsync(600);

    expect(diagnosticos(socket, 'viewer-visibilidade')).toHaveLength(0);
    expect(diagnosticos(socket, 'viewer-tamanho')).toHaveLength(0);
  });

  it('envia a saúde a cada 60s enquanto assiste', async () => {
    const socket = await assistirAna();
    expect(diagnosticos(socket, 'viewer-saude')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const saude = diagnosticos(socket, 'viewer-saude');
    expect(saude).toHaveLength(2);
    expect(saude[0].dados).toMatchObject({
      lagMs: 24,
      w: 1280,
      h: 720,
      streams: 1,
      recuperacoes: 0,
      telaCheia: false,
    });
    expect(typeof saude[0].dados.fps).toBe('number');
  });

  it('informa a retomada automática com o tempo de ausência', async () => {
    const socket = await assistirAna();
    socket.message({ type: 'stream-stop', slot: 0 });
    await vi.advanceTimersByTimeAsync(7000);

    socket.message({ type: 'stream-start', slot: 1, userId: 'ana', fonte: 'tela' });

    expect(diagnosticos(socket, 'viewer-retomada')[0].dados).toEqual({
      fonte: 'tela',
      ausenteMs: 7000,
    });
  });
});

describe('reportar problema e denunciar', () => {
  let jpegs;

  const chamadas = (caminho) =>
    fetch.mock.calls.filter(
      ([url]) => new URL(String(url), 'http://localhost').pathname === caminho,
    );
  const corpo = (caminho) => JSON.parse(chamadas(caminho).at(-1)[1].body);
  const digitar = (id, texto) => {
    const campo = document.getElementById(id);
    campo.value = texto;
    campo.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const escolher = (categoria) => {
    const radio = document.querySelector(`input[name="reportCat"][value="${categoria}"]`);
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  // O jsdom não desenha: o contexto e o JPEG são falsos, o fluxo é o de verdade.
  beforeEach(() => {
    jpegs = 0;
    const canvas = dom.window.HTMLCanvasElement.prototype;
    canvas.getContext = () => ({ drawImage: () => {} });
    canvas.toBlob = (cb) => cb(new Blob([`jpeg-${jpegs++}`], { type: 'image/jpeg' }));
    fetch.mockImplementation(
      ((original) => async (url, init) => {
        const pathname = new URL(String(url), 'http://localhost').pathname;
        if (pathname === '/api/relatos/bug') return json({ ok: true, id: 'bug-1' });
        if (pathname === '/api/relatos/denuncia') return json({ ok: true, id: 'den-1' });
        return original(url, init);
      })(fetch.getMockImplementation()),
    );
  });

  async function assistir(opcoes) {
    const socket = await entrar();
    anunciar(socket, opcoes);
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    // Primeiro quadro desenhado: sem ele não há o que copiar.
    jogadores.at(-1).onTamanho();
    return socket;
  }

  it('bloqueia o envio com menos de 10 caracteres e manda o contexto sem tokens', async () => {
    await assistir();
    await vi.advanceTimersByTimeAsync(1000);
    document.getElementById('reportBug').click();
    const modal = document.getElementById('bugModal');
    expect(modal.hidden).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('bugText'));

    digitar('bugText', 'curto');
    expect(document.getElementById('bugSend').disabled).toBe(true);
    digitar('bugText', 'a imagem congelou ao trocar de tela');
    expect(document.getElementById('bugSend').disabled).toBe(false);

    document.getElementById('bugSend').click();
    await vi.waitFor(() =>
      expect(document.getElementById('bugStatus').textContent).toBe('Recebido! Código bug-1'),
    );

    const enviado = corpo('/api/relatos/bug');
    expect(enviado).toMatchObject({
      token: 'viewer-sala-a',
      origem: 'atividade',
      texto: 'a imagem congelou ao trocar de tela',
    });
    expect(enviado.contexto.streams).toEqual([
      expect.objectContaining({
        slot: 0,
        fonte: 'tela',
        config: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
      }),
    ]);
    expect(enviado.contexto.connectionState).toBe('connected');
    const semToken = JSON.stringify(enviado.contexto);
    for (const privado of ['viewer-sala-a', 'guest-visitante', 'Ana', 'http://', 'identity']) {
      expect(semToken).not.toContain(privado);
    }

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.hidden).toBe(true);
  });

  it('mostra a mensagem de erro do servidor no relato', async () => {
    await assistir();
    document.getElementById('reportBug').click();
    digitar('bugText', 'a imagem congelou ao trocar de tela');
    fetch.mockImplementationOnce(async () => json({ error: 'Limite de relatos.' }, 429));
    document.getElementById('bugSend').click();
    await vi.waitFor(() =>
      expect(document.getElementById('bugStatus').textContent).toBe('Limite de relatos.'),
    );
  });

  it('não oferece denunciar a própria transmissão', async () => {
    const socket = await entrar();
    const eu = { id: 'guest-visitante', name: 'Visitante', broadcasting: true };
    socket.message({ ...estado(), participants: [eu] });
    socket.message({ type: 'stream-start', slot: 0, userId: eu.id, fonte: 'tela' });
    document.querySelector('.watch-prompt button').click();
    socket.message({ type: 'config', slot: 0, config });
    expect(document.querySelector('.tile-stop')).not.toBeNull();
    expect(document.querySelector('.tile-report')).toBeNull();
  });

  it('em Menores envia a denúncia sem nenhum print', async () => {
    await assistir({ userId: 'bruno' });
    await vi.advanceTimersByTimeAsync(11_000);
    const botao = document.querySelector('.tile-report');
    expect(botao.getAttribute('aria-label')).toBe('Denunciar transmissão');
    botao.click();

    expect(document.getElementById('reportModal').hidden).toBe(false);
    expect(document.getElementById('reportNote').textContent).toBe(
      'Prints dos últimos segundos desta transmissão serão enviados à moderação.',
    );
    expect(document.getElementById('reportSend').disabled).toBe(true);
    escolher('menores');
    expect(document.getElementById('reportNote').textContent).toContain(
      'Nenhuma imagem será enviada.',
    );
    document.getElementById('reportSend').click();
    await vi.waitFor(() =>
      expect(document.getElementById('reportStatus').textContent).toBe(
        'Denúncia enviada. Obrigado.',
      ),
    );
    expect(corpo('/api/relatos/denuncia')).toMatchObject({
      token: 'viewer-sala-a',
      slot: 0,
      categoria: 'menores',
      prints: [],
    });
  });

  it('exige texto em Outro', async () => {
    await assistir({ userId: 'bruno' });
    document.querySelector('.tile-report').click();
    escolher('outro');
    expect(document.getElementById('reportSend').disabled).toBe(true);
    digitar('reportText', 'abc');
    expect(document.getElementById('reportSend').disabled).toBe(true);
    digitar('reportText', 'conteúdo suspeito');
    expect(document.getElementById('reportSend').disabled).toBe(false);
  });

  it('guarda no máximo 3 prints por slot, ignora a aba oculta e soma um print na hora', async () => {
    await assistir({ userId: 'bruno' });
    await vi.advanceTimersByTimeAsync(5_000 * 8);
    expect(jpegs).toBe(8);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(5_000 * 4);
    expect(jpegs).toBe(8);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    document.querySelector('.tile-report').click();
    escolher('odio');
    document.getElementById('reportSend').click();
    await vi.waitFor(() => expect(chamadas('/api/relatos/denuncia')).toHaveLength(1));
    // 3 do buffer (os mais recentes) e 1 tirado ao abrir o modal.
    const { prints } = corpo('/api/relatos/denuncia');
    expect(prints).toHaveLength(4);
    for (const p of prints) expect(p).toMatch(/^data:image\/jpeg;base64,/);
    const textos = prints.map((p) => Buffer.from(p.split(',')[1], 'base64').toString());
    expect(textos).toEqual(['jpeg-5', 'jpeg-6', 'jpeg-7', 'jpeg-8']);
  });
});
