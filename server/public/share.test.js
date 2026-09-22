import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ instances: [] }));
vi.mock('/shared/broadcaster.js?v=13', () => ({
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

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  capture.instances.length = 0;
  sockets = [];
  const token = `${Buffer.from(JSON.stringify({ uid: 'teste', role: 'broadcaster', room: 'sala' })).toString('base64url')}.assinatura`;
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
