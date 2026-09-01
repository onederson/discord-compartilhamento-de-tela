import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from './async.js';

describe('prazo das integrações externas', () => {
  it('devolve o resultado quando a integração responde', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'demorou')).resolves.toBe('ok');
  });

  it('encerra uma espera presa com uma mensagem acionável', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise(() => {}), 5000, 'O Discord não respondeu.');
    const assertion = expect(result).rejects.toThrow('O Discord não respondeu.');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});
