import { describe, expect, it, vi } from 'vitest';

import { executarBuildComReparo } from './build-recovery.mjs';

const sucesso = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const falha = (stderr) => ({ status: 1, stdout: '', stderr });

describe('executarBuildComReparo', () => {
  it('reinstala as dependências e tenta compilar uma vez de novo', () => {
    const build = vi
      .fn()
      .mockReturnValueOnce(falha('rollup ausente'))
      .mockReturnValueOnce(sucesso());
    const reparar = vi.fn(() => sucesso('dependências reparadas'));

    expect(executarBuildComReparo({ build, reparar })).toMatchObject({
      ok: true,
      reparado: true,
      tentativas: 2,
    });
    expect(build).toHaveBeenCalledTimes(2);
    expect(reparar).toHaveBeenCalledOnce();
  });

  it('para depois de uma tentativa de reparo e preserva o erro real', () => {
    const build = vi.fn(() => falha('erro original do Vite'));
    const reparar = vi.fn(() => falha('npm sem acesso ao arquivo'));

    const resultado = executarBuildComReparo({ build, reparar });

    expect(resultado.ok).toBe(false);
    expect(resultado.etapa).toBe('dependencias');
    expect(resultado.detalhes).toContain('erro original do Vite');
    expect(resultado.detalhes).toContain('npm sem acesso ao arquivo');
    expect(build).toHaveBeenCalledOnce();
  });

  it('mostra o segundo erro quando a reinstalação não corrige o build', () => {
    const build = vi
      .fn()
      .mockReturnValueOnce(falha('primeira falha'))
      .mockReturnValueOnce(falha('plugin quebrou na segunda tentativa'));

    const resultado = executarBuildComReparo({ build, reparar: () => sucesso() });

    expect(resultado.ok).toBe(false);
    expect(resultado.etapa).toBe('build');
    expect(resultado.detalhes).toContain('plugin quebrou na segunda tentativa');
    expect(resultado.tentativas).toBe(2);
  });
});
