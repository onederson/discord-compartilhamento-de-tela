import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 128_000;
const SENSITIVE_KEY = /token|secret|password|senha|cookie|authorization|identity|proof|credential/i;

export function diagnosticoLigado(valor = '1') {
  return !/^(0|false|off|desligado|nao|não)$/i.test(String(valor).trim());
}

export function sanitizarTexto(valor) {
  return String(valor)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REMOVIDO]')
    .replace(
      /([?&](?:t|token|code|state|proof|access_token|refresh_token)=)[^&#\s]+/gi,
      '$1[REMOVIDO]',
    )
    .replace(/(DISCORD_(?:CLIENT_SECRET|BOT_TOKEN)|SESSION_SECRET)=[^\s]+/gi, '$1=[REMOVIDO]')
    .slice(0, 2_000);
}

export function sanitizarDados(valor, chave = '') {
  if (SENSITIVE_KEY.test(chave)) return '[REMOVIDO]';
  if (typeof valor === 'string') return sanitizarTexto(valor);
  if (typeof valor === 'number' || typeof valor === 'boolean' || valor == null) return valor;
  if (Array.isArray(valor)) return valor.slice(0, 50).map((item) => sanitizarDados(item));
  if (typeof valor !== 'object') return String(valor);

  return Object.fromEntries(
    Object.entries(valor)
      .slice(0, 50)
      .map(([nome, item]) => [nome, sanitizarDados(item, nome)]),
  );
}

function rotacionar(arquivo) {
  try {
    if (fs.statSync(arquivo).size < MAX_BYTES) return;
    const anterior = `${arquivo}.1`;
    fs.rmSync(anterior, { force: true });
    fs.renameSync(arquivo, anterior);
  } catch {
    // Arquivo ainda não existe ou não pode ser medido; a próxima escrita diz.
  }
}

export function createDiagnosticLogger({ raiz, habilitado = true, now = () => new Date() } = {}) {
  const pasta = path.join(raiz, '.logs');
  const arquivo = path.join(pasta, 'diagnostico.jsonl');

  function log(evento, dados = {}) {
    if (!habilitado) return false;
    const nome = String(evento)
      .replace(/[^a-z0-9_.-]/gi, '')
      .slice(0, 64);
    if (!nome) return false;

    try {
      fs.mkdirSync(pasta, { recursive: true });
      rotacionar(arquivo);
      const linha = {
        at: now().toISOString(),
        event: nome,
        app: 'discord-compartilhamento-de-tela',
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        data: sanitizarDados(dados),
      };
      fs.appendFileSync(arquivo, `${JSON.stringify(linha)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  return { log, arquivo, habilitado };
}

export function lerDiagnostico(arquivo, limite = MAX_UPLOAD_BYTES) {
  try {
    const tamanho = fs.statSync(arquivo).size;
    const inicio = Math.max(0, tamanho - limite);
    const fd = fs.openSync(arquivo, 'r');
    try {
      const buffer = Buffer.alloc(tamanho - inicio);
      fs.readSync(fd, buffer, 0, buffer.length, inicio);
      const texto = buffer.toString('utf8');
      return inicio ? texto.slice(texto.indexOf('\n') + 1) : texto;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export async function enviarDiagnostico({ arquivo, url, token = '', fetchImpl = fetch } = {}) {
  if (!url) return { status: 'desligado' };

  let destino;
  try {
    destino = new URL(url);
  } catch {
    return { status: 'url-invalida' };
  }
  if (destino.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(destino.hostname)) {
    return { status: 'url-insegura' };
  }

  const payload = lerDiagnostico(arquivo);
  if (!payload.trim()) return { status: 'vazio' };

  try {
    const headers = { 'Content-Type': 'application/x-ndjson' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resposta = await fetchImpl(destino, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(8_000),
    });
    return { status: resposta.ok ? 'enviado' : 'recusado', httpStatus: resposta.status };
  } catch {
    return { status: 'falhou' };
  }
}
