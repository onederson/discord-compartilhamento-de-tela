import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ instances: [] }));
vi.mock('/shared/broadcaster.js?v=14', () => ({
  supportError: () => null,
  fonteIndisponivel: () => null,
  opcoesTela: () => ({ video: true }),
  pedirDisplayMedia: vi.fn(),
  createBroadcaster: (options) => {
    const stream = { getTracks: () => [], getVideoTracks: () => [] };
    const broadcaster = {
      start: vi.fn().mockResolvedValue(stream),
      stop: vi.fn(() => options.onEnd('Transmissão encerrada.')),
      setQuality: vi.fn(),
      getSettings: () => ({ bitrate: options.bitrate, fps: options.fps }),
    };
    capture.instances.push({ options, broadcaster });
    return broadcaster;
  },
}));

const html = readFileSync(new URL('./share.html', import.meta.url), 'utf8');
let dom;
let sockets;

class SocketFalso {
  static OPEN = 1;
  constructor() {
    this.listeners = new Map();
    this.readyState = 0;
    sockets.push(this);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    if (type === 'open') this.readyState = SocketFalso.OPEN;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close() {
    this.readyState = 3;
  }
}

async function carregar(room = 'sala') {
  vi.resetModules();
  capture.instances.length = 0;
  sockets = [];
  const token = `${Buffer.from(JSON.stringify({ uid: 'teste', role: 'broadcaster', room })).toString('base64url')}.assinatura`;
  dom = new JSDOM(html, {
    url: `http://localhost/share.html?t=${token}&fps=60&q=5000000`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'navigator', 'location']) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
  vi.stubGlobal('WebSocket', SocketFalso);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      addEventListener() {}
      postMessage() {}
      close() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  vi.spyOn(dom.window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await import('./share.js');
}

beforeEach(async () => {
  vi.useFakeTimers();
  await carregar();
});

afterEach(() => {
  vi.clearAllTimers();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('página de captura', () => {
  it('mostra a qualidade recebida da Activity e atualiza quando ela muda', () => {
    const resumo = document.getElementById('quality-summary');
    expect(resumo).not.toBeNull();
    expect(resumo.textContent).toContain('60 fps');
    expect(resumo.textContent).toContain('5 Mb/s');
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'config-request', opcoes: { fps: 30, q: 1500000 } }),
    });
    expect(resumo.textContent).toContain('30 fps');
    expect(resumo.textContent).toContain('1,5 Mb/s');
    expect(capture.instances).toHaveLength(0);
  });

  it('distingue controle conectado de uma transmissão ao vivo', () => {
    sockets[0].dispatch('open');
    expect(document.getElementById('control-status')?.textContent).toBe('Conectado à sala');
    expect(document.getElementById('header-status-text').textContent).toBe('Offline');
    sockets[0].dispatch('close');
    expect(document.getElementById('control-status').textContent).toBe('Reconectando à sala');
  });

  it('permite alternar o tema com as setas do teclado', () => {
    const escuro = document.getElementById('theme-dark');
    escuro.focus();
    escuro.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    const claro = document.getElementById('theme-light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.activeElement).toBe(claro);
    expect(claro.tabIndex).toBe(0);
    expect(escuro.tabIndex).toBe(-1);
    expect(dom.window.localStorage.getItem('apple_theme')).toBe('light');
  });

  it('atualiza métricas sem recriar a lista de espectadores a cada segundo', async () => {
    document.getElementById('tela-start').click();
    await vi.waitFor(() => expect(document.getElementById('tela-live').hidden).toBe(false));
    const { options, broadcaster } = capture.instances[0];
    const stats = {
      viewers: 1,
      fps: 60,
      captureFps: 60,
      droppedFrames: 0,
      mbps: 4.5,
      seconds: 1,
      watchers: [{ id: 'pessoa', name: 'Participante' }],
    };
    options.onStats(stats);
    const primeiro = document.getElementById('tela-watchers-list').firstElementChild;
    options.onStats({ ...stats, seconds: 2, mbps: 4.7 });

    expect(document.getElementById('tela-watchers-list').firstElementChild).toBe(primeiro);
    expect(document.getElementById('tela-bitrate').textContent).toBe('4.7 Mb/s');
    expect(document.getElementById('header-status-text').textContent).toBe('Ao Vivo');
    expect(broadcaster.stop).not.toHaveBeenCalled();
    document.getElementById('tela-stop').click();
    expect(document.getElementById('header-status-text').textContent).toBe('Offline');
  });
});

describe('conexão de controle', () => {
  const hb = JSON.stringify({ type: 'hb' });
  const salaGone = { data: JSON.stringify({ type: 'room-gone' }) };

  it('sem hb o silêncio não derruba o controle', async () => {
    sockets[0].dispatch('open');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(SocketFalso.OPEN);
  });

  it('com hb, 25s de silêncio fecham o socket e religam em 3s', async () => {
    sockets[0].dispatch('open');
    sockets[0].dispatch('message', { data: hb });
    await vi.advanceTimersByTimeAsync(25_000);

    expect(sockets[0].readyState).toBe(3);
    expect(document.getElementById('control-status').textContent).toBe('Reconectando à sala');
    // O close real, tardio, não agenda uma segunda religação.
    sockets[0].dispatch('close');
    await vi.advanceTimersByTimeAsync(3000);
    expect(sockets).toHaveLength(2);
  });

  it('sala que não é de call continua morta após room-gone', async () => {
    sockets[0].dispatch('message', salaGone);
    sockets[0].dispatch('close');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
    expect(document.getElementById('control-status').textContent).toBe('Sala encerrada');
  });

  describe('sala de call', () => {
    beforeEach(async () => {
      dom.window.close();
      await carregar('call-123');
    });

    it('espera a atividade e tenta de novo a cada 5s após room-gone', async () => {
      sockets[0].dispatch('message', salaGone);
      sockets[0].dispatch('close');

      expect(document.getElementById('control-status').textContent).toBe(
        'Sala fechada — aguardando a atividade',
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(sockets).toHaveLength(2);
      sockets[1].dispatch('message', salaGone);
      sockets[1].dispatch('close');
      await vi.advanceTimersByTimeAsync(5000);
      expect(sockets).toHaveLength(3);
    });

    it('volta ao normal quando a sala responde', async () => {
      sockets[0].dispatch('message', salaGone);
      sockets[0].dispatch('close');
      await vi.advanceTimersByTimeAsync(5000);
      sockets[1].dispatch('open');
      sockets[1].dispatch('message', { data: JSON.stringify({ type: 'atividade-voltou' }) });

      expect(document.getElementById('control-status').textContent).toBe('Conectado à sala');
      expect(document.getElementById('pageStatus').textContent).toBe('');
    });

    it('desiste após 10 minutos com o comportamento antigo', async () => {
      sockets[0].dispatch('message', salaGone);
      sockets[0].dispatch('close');
      // Cada tentativa recebe room-gone de novo, até o prazo vencer.
      for (let i = 0; i < 130 && sockets.length < 200; i++) {
        await vi.advanceTimersByTimeAsync(5000);
        const ultimo = sockets.at(-1);
        if (ultimo.readyState === 3) continue;
        ultimo.dispatch('message', salaGone);
        ultimo.dispatch('close');
      }
      const total = sockets.length;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets).toHaveLength(total);
      expect(document.getElementById('control-status').textContent).toBe('Sala encerrada');
      expect(document.getElementById('pageStatus').textContent).toContain('A sala foi fechada');
    });
  });
});
