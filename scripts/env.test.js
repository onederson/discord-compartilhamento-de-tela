import { describe, expect, it } from 'vitest';

import { terminalLimpo } from './env.mjs';

describe('terminalLimpo', () => {
  it('vem ligado para o iniciador de usuários leigos', () => {
    expect(terminalLimpo({})).toBe(true);
  });

  it.each(['0', 'false', 'off', 'desligado', 'nao', 'não'])(
    'aceita %s para ativar a saída de desenvolvedor',
    (valor) => expect(terminalLimpo({ TERMINAL_LIMPO: valor })).toBe(false),
  );

  it.each(['1', 'true', 'on', 'qualquer-coisa'])('mantém a saída limpa com %s', (valor) =>
    expect(terminalLimpo({ TERMINAL_LIMPO: valor })).toBe(true),
  );
});
