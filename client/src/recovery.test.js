import { describe, expect, it } from 'vitest';
import { recoverableSlots, shouldRecoverStream } from './recovery.js';

describe('recuperacao do espectador', () => {
  it('detecta stream iniciado sem quadro por tempo suficiente', () => {
    expect(
      shouldRecoverStream({
        visible: true,
        started: true,
        lastFrameAt: 1_000,
        lastRecoveryAt: 0,
        now: 5_000,
      }),
    ).toBe(true);
  });

  it('não cria tempestade em segundo plano ou durante o cooldown', () => {
    const base = { started: true, lastFrameAt: 1_000, now: 5_000 };
    expect(shouldRecoverStream({ ...base, visible: false })).toBe(false);
    expect(shouldRecoverStream({ ...base, visible: true, lastRecoveryAt: 4_000 })).toBe(false);
  });

  it('reassiste somente slots que continuam no ar após reconectar', () => {
    expect(
      recoverableSlots(
        new Set([1, 2, 3]),
        new Map([
          [1, {}],
          [3, {}],
        ]),
      ),
    ).toEqual([1, 3]);
  });
});
