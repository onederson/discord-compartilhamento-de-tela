import { describe, expect, it } from 'vitest';

import { terminalLimpo, servidoresPermitidos, permitirWeb } from './env.mjs';

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

describe('servidoresPermitidos', () => {
  it('retorna array vazio quando DISCORD_GUILD_ID não está definido', () => {
    expect(servidoresPermitidos({})).toEqual([]);
    expect(servidoresPermitidos({ DISCORD_GUILD_ID: '' })).toEqual([]);
  });

  it('separa múltiplos IDs por vírgula e remove espaços', () => {
    expect(
      servidoresPermitidos({ DISCORD_GUILD_ID: '123456789012345678, 987654321098765432 ' }),
    ).toEqual(['123456789012345678', '987654321098765432']);
  });
});

describe('permitirWeb', () => {
  it('permite web por padrão quando não há servidores restritos', () => {
    expect(permitirWeb({})).toBe(true);
  });

  it('desativa web por padrão quando DISCORD_GUILD_ID está configurado', () => {
    expect(permitirWeb({ DISCORD_GUILD_ID: '123456789012345678' })).toBe(false);
  });

  it.each(['0', 'false', 'off', 'desligado', 'nao', 'não'])(
    'desativa web quando PERMITIR_WEB é %s',
    (valor) => expect(permitirWeb({ PERMITIR_WEB: valor })).toBe(false),
  );

  it.each(['1', 'true', 'on'])('permite web quando PERMITIR_WEB é explicitamente %s', (valor) =>
    expect(permitirWeb({ PERMITIR_WEB: valor, DISCORD_GUILD_ID: '123456789012345678' })).toBe(true),
  );
});
