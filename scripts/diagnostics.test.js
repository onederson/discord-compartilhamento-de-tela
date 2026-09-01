import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticLogger,
  enviarDiagnostico,
  sanitizarDados,
  sanitizarTexto,
} from './diagnostics.mjs';

const dirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-screen-log-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('diagnóstico privativo', () => {
  it('remove segredos por chave e por texto', () => {
    expect(sanitizarDados({ token: 'abc', nested: { clientSecret: 'xyz' }, ok: 'sim' })).toEqual({
      token: '[REMOVIDO]',
      nested: { clientSecret: '[REMOVIDO]' },
      ok: 'sim',
    });
    expect(sanitizarTexto('https://x.test/?t=abc&code=xyz')).toBe(
      'https://x.test/?t=[REMOVIDO]&code=[REMOVIDO]',
    );
  });

  it('grava JSONL local sem o valor sensível', () => {
    const logger = createDiagnosticLogger({ raiz: tmp() });
    logger.log('viewer.recovery', { reason: 'stall', authorization: 'Bearer segredo' });
    const texto = fs.readFileSync(logger.arquivo, 'utf8');

    expect(texto).toContain('viewer.recovery');
    expect(texto).not.toContain('segredo');
  });

  it('não envia sem opt-in e recusa HTTP externo', async () => {
    const fetchImpl = vi.fn();
    expect(await enviarDiagnostico({ url: '', fetchImpl })).toEqual({ status: 'desligado' });
    expect(await enviarDiagnostico({ url: 'http://exemplo.test/log', fetchImpl })).toEqual({
      status: 'url-insegura',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('envia somente o arquivo sanitizado para HTTPS configurado', async () => {
    const logger = createDiagnosticLogger({ raiz: tmp() });
    logger.log('startup', { ok: true });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    expect(
      await enviarDiagnostico({
        arquivo: logger.arquivo,
        url: 'https://telemetria.example.test/ingest',
        token: 'token-de-upload',
        fetchImpl,
      }),
    ).toEqual({ status: 'enviado', httpStatus: 204 });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('startup') }),
    );
  });
});
