import { describe, expect, it } from 'vitest';
import { createCaixaPreta } from './caixa-preta.js';

function memoria() {
  const dados = new Map();
  return {
    getItem: (k) => dados.get(k) ?? null,
    setItem: (k, v) => dados.set(k, String(v)),
  };
}

describe('caixa-preta', () => {
  it('detecta a sessão anterior que morreu sem pagehide', () => {
    const storage = memoria();
    let t = 1_000;
    const primeira = createCaixaPreta({ storage, agora: () => t });
    primeira.iniciar();
    t += 5_000;
    primeira.registrar('janela.blur');

    const segunda = createCaixaPreta({ storage, agora: () => t + 60_000 });
    const { anterior, morreuSemAviso } = segunda.iniciar();

    expect(morreuSemAviso).toBe(true);
    const r = segunda.resumo(anterior);
    expect(r.trilha).toEqual(['+5.0s janela.blur']);
    expect(r.duracaoS).toBe(5);
    expect(r.haQuantoS).toBe(60);
  });

  it('não acusa crash quando a sessão anterior terminou no pagehide', () => {
    const storage = memoria();
    const primeira = createCaixaPreta({ storage });
    primeira.iniciar();
    primeira.encerrar('pagehide');

    expect(createCaixaPreta({ storage }).iniciar().morreuSemAviso).toBe(false);
  });

  it('guarda só os eventos mais recentes', () => {
    const caixa = createCaixaPreta({ storage: memoria(), limite: 3 });
    caixa.iniciar();
    for (let i = 0; i < 5; i++) caixa.registrar(`e${i}`);

    expect(caixa.resumo().trilha.map((l) => l.split(' ')[1])).toEqual(['e2', 'e3', 'e4']);
  });

  it('segue funcionando sem armazenamento', () => {
    const caixa = createCaixaPreta({
      storage: {
        getItem() {
          throw new Error('bloqueado');
        },
        setItem() {
          throw new Error('bloqueado');
        },
      },
    });
    expect(caixa.iniciar().morreuSemAviso).toBe(false);
    caixa.registrar('ws.close', { code: 1006 });
    expect(caixa.resumo().trilha[0]).toMatch(/ws\.close code=1006$/);
  });
});
