import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const postMessage = vi.fn();
vi.stubGlobal('postMessage', postMessage);
await import('./frame-worker.js');

describe('relógio de quadros do fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessage.mockClear();
    globalThis.onmessage({ data: { type: 'stop' } });
  });

  afterAll(() => {
    globalThis.onmessage({ data: { type: 'stop' } });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignora mensagens que não alteram o relógio', () => {
    globalThis.onmessage({ data: null });
    globalThis.onmessage({ data: { type: 'outro' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limita a 60 fps, emite ticks e agenda o próximo', () => {
    globalThis.onmessage({ data: { type: 'start', fps: 120 } });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(17);
    expect(postMessage).toHaveBeenCalledWith({ type: 'tick' });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('usa 30 fps para valor inválido e permite parar', () => {
    globalThis.onmessage({ data: { type: 'fps', fps: 'inválido' } });
    vi.advanceTimersByTime(32);
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(postMessage).toHaveBeenCalledOnce();

    globalThis.onmessage({ data: { type: 'stop' } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
