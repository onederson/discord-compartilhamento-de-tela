import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { atualizacaoLigada, atualizarCheckout, normalizarOrigem } from './updater.mjs';

const temporarios = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-screen-update-'));
  temporarios.push(dir);
  return dir;
};
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const commit = (cwd, arquivo, conteudo, mensagem) => {
  fs.writeFileSync(path.join(cwd, arquivo), conteudo);
  git(cwd, 'add', arquivo);
  git(
    cwd,
    '-c',
    'user.name=Teste',
    '-c',
    'user.email=teste@example.test',
    'commit',
    '-m',
    mensagem,
  );
};

afterEach(() => {
  for (const dir of temporarios.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('atualizador conservador', () => {
  it('normaliza as duas formas usuais da origem oficial', () => {
    expect(
      normalizarOrigem('https://github.com/DevilNine/discord-compartilhamento-de-tela.git'),
    ).toBe('github.com/devilnine/discord-compartilhamento-de-tela');
    expect(normalizarOrigem('git@github.com:DevilNine/discord-compartilhamento-de-tela.git')).toBe(
      'github.com/devilnine/discord-compartilhamento-de-tela',
    );
  });

  it.each(['0', 'false', 'off', 'não'])('permite desligar com %s', (valor) => {
    expect(atualizacaoLigada(valor)).toBe(false);
  });

  it('não tenta substituir uma distribuição ZIP', () => {
    expect(atualizarCheckout({ raiz: tmp() })).toEqual({ status: 'zip' });
  });

  it('não toca num checkout com mudanças locais', () => {
    const raiz = tmp();
    git(raiz, 'init');
    commit(raiz, 'arquivo.txt', 'base', 'base');
    git(
      raiz,
      'remote',
      'add',
      'origin',
      'https://github.com/DevilNine/discord-compartilhamento-de-tela.git',
    );
    fs.writeFileSync(path.join(raiz, 'arquivo.txt'), 'mudança local');

    expect(atualizarCheckout({ raiz })).toEqual({ status: 'alterado' });
    expect(fs.readFileSync(path.join(raiz, 'arquivo.txt'), 'utf8')).toBe('mudança local');
  });

  it('aplica somente fast-forward do origin/main', () => {
    const remoto = tmp();
    const autor = tmp();
    const clone = tmp();
    git(remoto, 'init', '--bare');
    git(autor, 'init', '-b', 'main');
    commit(autor, 'arquivo.txt', 'v1', 'v1');
    git(autor, 'remote', 'add', 'origin', remoto);
    git(autor, 'push', '-u', 'origin', 'main');
    git(remoto, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.rmSync(clone, { recursive: true, force: true });
    git(path.dirname(clone), 'clone', remoto, clone);
    git(
      clone,
      'remote',
      'set-url',
      'origin',
      'https://github.com/DevilNine/discord-compartilhamento-de-tela.git',
    );

    commit(autor, 'arquivo.txt', 'v2', 'v2');
    git(autor, 'push', 'origin', 'main');

    const executar = (cwd, args, options) => {
      const reais = args[0] === 'fetch' ? ['fetch', remoto, 'main:refs/remotes/origin/main'] : args;
      return spawnSync('git', reais, { cwd, encoding: 'utf8', timeout: options?.timeout });
    };
    const resultado = atualizarCheckout({ raiz: clone, git: executar });

    expect(resultado).toEqual({ status: 'atualizada', commits: 1 });
    expect(fs.readFileSync(path.join(clone, 'arquivo.txt'), 'utf8')).toBe('v2');
  });
});
