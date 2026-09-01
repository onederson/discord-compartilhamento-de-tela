import { describe, expect, it } from 'vitest';
import { atrasoReinicio } from './reinicio.mjs';

describe('politica de reinicio', () => {
  it('cresce sem ultrapassar o teto', () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => atrasoReinicio(n))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('normaliza tentativas invalidas', () => {
    expect(atrasoReinicio(-4)).toBe(2_000);
    expect(atrasoReinicio(Number.NaN)).toBe(2_000);
  });
});
