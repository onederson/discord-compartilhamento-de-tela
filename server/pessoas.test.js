import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { criarRegistroPessoas } from './pessoas.js';

const DIA = 24 * 60 * 60 * 1000;
const pessoa = (uid) =>
  crypto.createHash('sha256').update(String(uid)).digest('base64url').slice(0, 8);

let base;
let arquivo;
let agora;
let instancia;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pessoas-test-'));
  arquivo = path.join(base, 'pessoas.json');
  agora = Date.UTC(2026, 10, 10, 15, 0, 0);
  instancia = null;
});

afterEach(() => {
  if (instancia) {
    instancia.gravarAgora();
    instancia = null;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('criarRegistroPessoas', () => {
  it('registra e lista uma pessoa', () => {
    const reg = (instancia = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    }));

    reg.registrar('123456789', 'Alice');

    const lista = reg.listar();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toEqual({
      pessoa: pessoa('123456789'),
      uid: '123456789',
      nome: 'Alice',
      convidado: false,
      primeiraVez: new Date(agora).toISOString(),
      ultimaVez: new Date(agora).toISOString(),
      vezes: 1,
    });

    // ignora uid vazio ou nulo
    reg.registrar('', 'Invalido');
    reg.registrar('   ', 'Invalido');
    reg.registrar(null, 'Invalido');
    reg.registrar(undefined, 'Invalido');
    expect(reg.listar()).toHaveLength(1);

    // apara espaços e trunca nome a 64 chars
    reg.registrar('999', `   ${'a'.repeat(80)}   `);
    const p999 = reg.listar().find((x) => x.uid === '999');
    expect(p999.nome).toBe('a'.repeat(64));
  });

  it('atualiza nome e vezes', () => {
    const reg = (instancia = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    }));

    reg.registrar('123456789', 'Alice');
    const primeiraData = new Date(agora).toISOString();

    agora += 5000;
    const segundaData = new Date(agora).toISOString();
    reg.registrar('123456789', 'Alice Silva');

    let lista = reg.listar();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      uid: '123456789',
      nome: 'Alice Silva',
      primeiraVez: primeiraData,
      ultimaVez: segundaData,
      vezes: 2,
    });

    // nome vazio não apaga nome existente
    agora += 5000;
    reg.registrar('123456789', '');
    lista = reg.listar();
    expect(lista[0].nome).toBe('Alice Silva');
    expect(lista[0].vezes).toBe(3);
    expect(lista[0].ultimaVez).toBe(new Date(agora).toISOString());
  });

  it('ordena por última vez desc', () => {
    const reg = (instancia = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    }));

    reg.registrar('user-1', 'Primeiro');
    agora += 1000;
    reg.registrar('user-2', 'Segundo');
    agora += 1000;
    reg.registrar('user-3', 'Terceiro');
    agora += 1000;
    // user-1 volta a acessar
    reg.registrar('user-1', 'Primeiro Atualizado');

    const lista = reg.listar();
    expect(lista.map((x) => x.uid)).toEqual(['user-1', 'user-3', 'user-2']);
  });

  it('marca convidado', () => {
    const reg = (instancia = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    }));

    reg.registrar('guest-abcd1234', 'Convidado 1234');
    reg.registrar('123456789012345678', 'Membro Discord');

    const guest = reg.listar().find((x) => x.uid === 'guest-abcd1234');
    const discord = reg.listar().find((x) => x.uid === '123456789012345678');

    expect(guest.convidado).toBe(true);
    expect(discord.convidado).toBe(false);
  });

  it('descarta quem passou de 30 dias (use agora injetado)', () => {
    const reg = (instancia = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      diasRetencao: 30,
      pseudonimo: pessoa,
    }));

    reg.registrar('antigo', 'Antigo');

    // 29 dias depois: ainda deve estar presente
    agora += 29 * DIA;
    expect(reg.listar()).toHaveLength(1);

    // 31 dias depois: deve ser descartado
    agora += 2 * DIA;
    expect(reg.listar()).toHaveLength(0);
  });

  it('grava e relê do disco', () => {
    const reg1 = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    });

    reg1.registrar('user-1', 'Alice');
    reg1.registrar('guest-1', 'Convidado');
    reg1.gravarAgora();

    expect(fs.existsSync(arquivo)).toBe(true);
    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    expect(salvo.pessoas).toHaveLength(2);

    const reg2 = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      pseudonimo: pessoa,
    });

    expect(reg2.listar()).toEqual(reg1.listar());
  });

  it('descarta registros vencidos ao ler e ao gravar no disco', () => {
    const reg1 = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      diasRetencao: 30,
      pseudonimo: pessoa,
    });

    reg1.registrar('velho', 'Velho');
    reg1.gravarAgora();

    // Passam-se 31 dias
    agora += 31 * DIA;

    // Novo registro lê do disco mas descarta o velho
    const reg2 = criarRegistroPessoas({
      arquivo,
      agora: () => agora,
      diasRetencao: 30,
      pseudonimo: pessoa,
    });
    expect(reg2.listar()).toHaveLength(0);

    // Grava de novo: o arquivo não deve mais conter o registro velho
    reg2.gravarAgora();
    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    expect(salvo.pessoas).toHaveLength(0);
  });

  it('arquivo corrompido não lança', () => {
    fs.writeFileSync(arquivo, 'invalido { [ json');

    expect(() => {
      const reg = criarRegistroPessoas({
        arquivo,
        agora: () => agora,
        pseudonimo: pessoa,
      });
      expect(reg.listar()).toEqual([]);
    }).not.toThrow();
  });

  it('erro de disco na gravação não derruba e loga no console.error', () => {
    const erroConsole = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Usa um diretório existente como nome de arquivo temporário para forçar erro de escrita
    const reg = criarRegistroPessoas({
      arquivo: path.join(base, 'subpasta_bloqueada'),
      pseudonimo: pessoa,
    });

    // Cria a pasta onde o .tmp tentaria ser gravado mas força renameSync a falhar com mock
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    reg.registrar('user-err', 'Teste');
    expect(() => reg.gravarAgora()).not.toThrow();
    expect(erroConsole).toHaveBeenCalled();

    renameSpy.mockRestore();
    erroConsole.mockRestore();
  });

  it('agenda gravação com debounce de 10s', () => {
    vi.useFakeTimers();
    try {
      const reg = criarRegistroPessoas({
        arquivo,
        agora: () => agora,
        pseudonimo: pessoa,
      });

      reg.registrar('u1', 'Nome 1');
      expect(fs.existsSync(arquivo)).toBe(false);

      // Avança 5s: ainda não gravou
      vi.advanceTimersByTime(5000);
      expect(fs.existsSync(arquivo)).toBe(false);

      // Segundo registro dentro da janela: não reseta o debounce
      reg.registrar('u2', 'Nome 2');

      // Avança mais 5s (total 10s desde o primeiro): gravou
      vi.advanceTimersByTime(5000);
      expect(fs.existsSync(arquivo)).toBe(true);

      const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      expect(salvo.pessoas).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
