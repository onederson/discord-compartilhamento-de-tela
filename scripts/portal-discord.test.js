import { describe, expect, it } from 'vitest';
import { ajudaRedirecionamento } from './portal-discord.mjs';

describe('ajuda do Developer Portal', () => {
  it('explica o botão e o crash observado sem sugerir API interna', () => {
    const ajuda = ajudaRedirecionamento('https://tela.exemplo.com/auth/callback');

    expect(ajuda.redirectUri).toBe('https://tela.exemplo.com/auth/callback');
    expect(ajuda.botao).toContain('deve criar uma caixa nesta mesma página');
    expect(ajuda.falha).toContain('removeChild');
    expect(ajuda.falha).toContain('janela anônima');
    expect(ajuda.seguranca).toContain('Redefina o Secret');
  });

  it.each([
    'http://tela.exemplo.com/auth/callback',
    'https://tela.exemplo.com/callback',
    'não-é-url',
  ])('recusa Redirect inseguro ou diferente do callback: %s', (url) => {
    expect(() => ajudaRedirecionamento(url)).toThrow();
  });
});
