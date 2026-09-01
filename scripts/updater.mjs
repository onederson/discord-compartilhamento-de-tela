import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPOSITORIO_OFICIAL = 'github.com/devilnine/discord-compartilhamento-de-tela';

export function atualizacaoLigada(valor = '1') {
  return !/^(0|false|off|desligado|nao|não)$/i.test(String(valor).trim());
}

export function normalizarOrigem(valor = '') {
  return String(valor)
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

const executarGit = (raiz, args, { timeout = 12_000 } = {}) =>
  spawnSync('git', args, {
    cwd: raiz,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });

const texto = (resultado) => String(resultado?.stdout ?? '').trim();

/**
 * Atualiza somente um checkout oficial, limpo e estritamente atrás do main.
 * Nunca faz reset, stash, checkout forçado ou merge com commit local.
 */
export function atualizarCheckout({ raiz, habilitada = true, git = executarGit } = {}) {
  if (!habilitada) return { status: 'desligada' };
  if (!raiz || !fs.existsSync(path.join(raiz, '.git'))) return { status: 'zip' };

  const dentro = git(raiz, ['rev-parse', '--is-inside-work-tree']);
  if (dentro.status !== 0 || texto(dentro) !== 'true') return { status: 'indisponivel' };

  const origem = git(raiz, ['remote', 'get-url', 'origin']);
  if (origem.status !== 0) return { status: 'sem-origem' };
  if (normalizarOrigem(texto(origem)) !== REPOSITORIO_OFICIAL) {
    return { status: 'origem-diferente' };
  }

  const sujo = git(raiz, ['status', '--porcelain', '--untracked-files=normal']);
  if (sujo.status !== 0) return { status: 'indisponivel' };
  if (texto(sujo)) return { status: 'alterado' };

  const fetch = git(raiz, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  if (fetch.status !== 0) {
    return { status: fetch.signal === 'SIGTERM' ? 'timeout' : 'sem-rede' };
  }

  const remotos = git(raiz, ['rev-list', '--count', 'HEAD..origin/main']);
  const locais = git(raiz, ['rev-list', '--count', 'origin/main..HEAD']);
  if (remotos.status !== 0 || locais.status !== 0) return { status: 'indisponivel' };

  const atras = Number(texto(remotos));
  const adiante = Number(texto(locais));
  if (!Number.isFinite(atras) || !Number.isFinite(adiante)) return { status: 'indisponivel' };
  if (atras === 0) return { status: 'atual', adiante };
  if (adiante > 0) return { status: 'divergente', atras, adiante };

  const merge = git(raiz, ['merge', '--ff-only', 'origin/main']);
  if (merge.status !== 0) return { status: 'falhou' };
  return { status: 'atualizada', commits: atras };
}

export function mensagemAtualizacao(resultado) {
  const mensagens = {
    desligada: null,
    atual: null,
    atualizada: `Atualização instalada (${resultado.commits} commit${resultado.commits === 1 ? '' : 's'}).`,
    zip: 'Atualização automática indisponível neste ZIP; baixe uma versão nova pelo GitHub.',
    alterado: 'Atualização ignorada porque há arquivos modificados; nada foi sobrescrito.',
    divergente: 'Atualização ignorada porque este checkout tem commits próprios.',
    'origem-diferente': 'Atualização ignorada porque o origin não é o repositório oficial.',
    'sem-origem': 'Atualização ignorada porque o Git não tem remote origin.',
    'sem-rede': 'Não foi possível verificar atualizações agora; o programa continuará offline.',
    timeout: 'A verificação de atualização demorou demais; o programa continuará.',
    falhou: 'A atualização não pôde ser aplicada; nenhum reset foi executado.',
    indisponivel: 'O Git não está disponível para verificar atualizações.',
  };
  return mensagens[resultado.status] ?? null;
}
