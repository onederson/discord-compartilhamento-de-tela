import { describe, expect, it, vi } from 'vitest';

import { enviarWebhook, montarMensagem, webhookValido } from './webhook.js';

const URL_OK = 'https://discord.com/api/webhooks/1/abc';

const bug = {
  id: '20261109-123045-abcd',
  tipo: 'bug',
  criadoEm: '2026-11-09T12:30:45.000Z',
  origem: 'atividade',
  texto: 'a tela trava',
  quem: { nome: 'Ana' },
  sala: { id: 's1', nome: 'Sala' },
  contexto: { inDiscord: true, clienteMovel: false, userAgent: 'Discord/1.0 Chrome/148' },
};

const denuncia = {
  ...bug,
  tipo: 'denuncia',
  categoria: 'golpe',
  alvo: { nome: 'Beto', uid: '999', fonte: 'tela' },
  prints: 1,
};

describe('montarMensagem', () => {
  it('nunca deixa o texto do usuário mencionar ninguém', () => {
    const m = montarMensagem({ ...bug, texto: '@everyone <@123>' }, 'https://x.test');
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });

  it('trunca o texto em 1000 caracteres', () => {
    const m = montarMensagem({ ...bug, texto: 'a'.repeat(5000) }, 'https://x.test');
    expect(m.embeds[0].description.length).toBeLessThanOrEqual(1000);
  });

  it('relato de bug: título, origem, plataforma, sala, autor e link do painel', () => {
    const e = montarMensagem(bug, 'https://x.test/').embeds[0];
    expect(e.title).toBe('🐞 Problema relatado');
    expect(e.url).toBe('https://x.test/admin#relato-20261109-123045-abcd');
    const texto = JSON.stringify(e.fields);
    expect(texto).toContain('atividade · Discord · Discord/1.0 Chrome/148');
    expect(texto).toContain('Sala (s1)');
    expect(texto).toContain('Ana');
    expect(texto).not.toContain('Quem transmitia');
  });

  it('denúncia: categoria legível, alvo com id e print anexado', () => {
    const e = montarMensagem(denuncia, 'https://x.test').embeds[0];
    expect(e.title).toBe('🚩 Denúncia: Golpe ou fraude');
    expect(JSON.stringify(e.fields)).toContain('Beto (999)');
    expect(e.image).toEqual({ url: 'attachment://print-1.jpg' });
  });

  it('menores: urgente, sem imagem e com o lembrete', () => {
    const m = montarMensagem(
      { ...denuncia, categoria: 'menores', urgente: true, prints: 3 },
      'https://x.test',
    );
    const e = m.embeds[0];
    expect(e.title).toBe('🚨 URGENTE — risco a menores');
    expect(e.image).toBeUndefined();
    expect(JSON.stringify(m)).toContain('Nenhuma imagem foi guardada');
    expect(JSON.stringify(m)).toContain('SaferNet');
  });
});

describe('webhookValido', () => {
  it('só aceita os endereços de webhook do Discord', () => {
    expect(webhookValido(URL_OK)).toBe(true);
    expect(webhookValido('https://discordapp.com/api/webhooks/1/abc')).toBe(true);
    expect(webhookValido('https://evil.test/api/webhooks/1/abc')).toBe(false);
    expect(webhookValido('http://discord.com/api/webhooks/1/abc')).toBe(false);
    expect(webhookValido('')).toBe(false);
    expect(webhookValido(undefined)).toBe(false);
  });
});

describe('enviarWebhook', () => {
  it('manda payload_json e os prints como arquivos jpeg', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const ok = await enviarWebhook(URL_OK, { embeds: [] }, [Buffer.from([0xff, 0xd8, 0xff])], {
      fetchImpl,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(init.body.get('payload_json')).toBe('{"embeds":[]}');
    const arquivo = init.body.get('files[0]');
    expect(arquivo.type).toBe('image/jpeg');
    expect(arquivo.name).toBe('print-1.jpg');
  });

  it('não envia para endereço fora do Discord', async () => {
    const fetchImpl = vi.fn();
    expect(await enviarWebhook('https://evil.test/x', {}, [], { fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('nunca lança: registra o status e a falha de rede, sem a URL', async () => {
    const log = vi.fn();
    const recusa = async () => ({ ok: false, status: 429 });
    expect(await enviarWebhook(URL_OK, {}, [], { log, fetchImpl: recusa })).toBe(false);
    expect(log).toHaveBeenLastCalledWith('relato.webhook-erro', { status: 429 });

    const cai = async () => {
      throw new Error('rede');
    };
    expect(await enviarWebhook(URL_OK, {}, [], { log, fetchImpl: cai })).toBe(false);
    expect(log).toHaveBeenLastCalledWith('relato.webhook-erro', { status: 0, erro: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('abc');
  });
});
