import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { criarBufferEventos, criarRelatos } from './relatos.js';

const DIA = 24 * 60 * 60 * 1000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let base;
let agora;
const novo = (extra = {}) => criarRelatos({ base, agora: () => agora, ...extra });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'relatos-'));
  agora = Date.UTC(2026, 10, 9, 12, 30, 45);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('salvar e ler', () => {
  it('grava relato.json e os prints numa pasta com o id no formato combinado', () => {
    const r = novo();
    const id = r.salvar('denuncia', { texto: 'olha isso', categoria: 'golpe' }, [JPEG, JPEG]);

    expect(id).toMatch(/^20261109-123045-[0-9a-f]{4}$/);
    const pasta = path.join(base, 'relatos', id);
    expect(fs.readdirSync(pasta).sort()).toEqual(['print-1.jpg', 'print-2.jpg', 'relato.json']);
    expect(r.ler(id)).toMatchObject({
      id,
      tipo: 'denuncia',
      status: 'aberto',
      texto: 'olha isso',
      prints: 2,
    });
  });

  it('recusa um tipo desconhecido', () => {
    expect(() => novo().salvar('xis', {})).toThrow(/tipo/);
  });

  it('dois relatos no mesmo segundo ganham ids diferentes', () => {
    const r = novo();
    const ids = new Set(Array.from({ length: 20 }, () => r.salvar('bug', { texto: 'a' })));
    expect(ids.size).toBe(20);
  });
});

describe('id e caminhos', () => {
  it('não deixa um id sair da pasta de relatos', () => {
    const r = novo();
    r.salvar('bug', { texto: 'a' });
    fs.writeFileSync(path.join(base, 'segredo.json'), '{"x":1}');

    for (const ruim of ['../segredo', '..', '../../etc/passwd', '20261109-123045-zzzz', '', null]) {
      expect(r.ler(ruim)).toBeNull();
      expect(r.caminhoPrint(ruim, 1)).toBeNull();
      expect(r.marcarResolvido(ruim, 'x', 'adm')).toBeNull();
    }
  });

  it('caminhoPrint só devolve print que existe', () => {
    const r = novo();
    const id = r.salvar('denuncia', { texto: 'a' }, [JPEG]);

    expect(r.caminhoPrint(id, 1)).toBe(path.join(base, 'relatos', id, 'print-1.jpg'));
    expect(r.caminhoPrint(id, 2)).toBeNull();
    expect(r.caminhoPrint(id, '../1')).toBeNull();
    expect(r.caminhoPrint(id, 0)).toBeNull();
  });
});

describe('listar e resolver', () => {
  it('lista do mais recente ao mais antigo, com filtros e prévia', () => {
    const r = novo();
    const a = r.salvar('bug', { texto: 'primeiro', quem: { nome: 'Ana' } });
    agora += 1000;
    const b = r.salvar('denuncia', { texto: 'x'.repeat(500), categoria: 'odio', urgente: false });
    agora += 1000;
    const c = r.salvar('bug', { texto: 'terceiro' });
    r.marcarResolvido(a, 'ok', 'Admin');

    expect(r.listar().map((x) => x.id)).toEqual([c, b, a]);
    expect(r.listar({ tipo: 'bug' }).map((x) => x.id)).toEqual([c, a]);
    expect(r.listar({ status: 'resolvido' }).map((x) => x.id)).toEqual([a]);
    expect(r.listar({ limite: 1 })).toHaveLength(1);
    const resumo = r.listar({ tipo: 'denuncia' })[0];
    expect(resumo.previa).toHaveLength(140);
    expect(resumo.categoria).toBe('odio');
    expect(resumo).not.toHaveProperty('contexto');
  });

  it('marcarResolvido guarda a nota e quem resolveu', () => {
    const r = novo();
    const id = r.salvar('bug', { texto: 'a' });
    const relato = r.marcarResolvido(id, '  era o cabo  ', 'Admin');

    expect(relato.status).toBe('resolvido');
    expect(r.ler(id).resolucao).toMatchObject({ nota: 'era o cabo', por: 'Admin' });
  });

  it('ignora pasta com nome estranho e relato ilegível', () => {
    const r = novo();
    const id = r.salvar('bug', { texto: 'a' });
    fs.mkdirSync(path.join(base, 'relatos', 'lixo'));
    fs.writeFileSync(path.join(base, 'relatos', id, 'relato.json'), '{quebrado');

    expect(r.listar()).toEqual([]);
  });
});

describe('retenção', () => {
  it('apaga prints com mais de 30 dias e mantém o texto', () => {
    const r = novo();
    const velho = r.salvar('denuncia', { texto: 'velho' }, [JPEG]);
    agora += 31 * DIA;
    const recente = r.salvar('denuncia', { texto: 'novo' }, [JPEG]);

    expect(r.caminhoPrint(velho, 1)).toBeNull();
    expect(r.ler(velho).texto).toBe('velho');
    expect(r.caminhoPrint(recente, 1)).not.toBeNull();
  });

  it('mantém no máximo o teto de relatos, apagando os mais antigos', () => {
    const r = novo({ maxRelatos: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(r.salvar('bug', { texto: `r${i}` }));
      agora += 1000;
    }

    expect(r.listar().map((x) => x.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(fs.existsSync(path.join(base, 'relatos', ids[0]))).toBe(false);
  });
});

describe('bloqueios', () => {
  it('bloqueia, lista e desbloqueia', () => {
    const r = novo();
    expect(r.estaBloqueado('123')).toBe(false);

    r.bloquear('123', { nome: 'Fulano', motivo: 'golpe', por: 'Admin' });
    expect(r.estaBloqueado('123')).toBe(true);
    expect(r.listarBloqueios()).toMatchObject([{ uid: '123', nome: 'Fulano', motivo: 'golpe' }]);

    expect(r.desbloquear('123')).toBe(true);
    expect(r.estaBloqueado('123')).toBe(false);
    expect(r.desbloquear('123')).toBe(false);
  });

  it('sobrevive a um novo arranque e não deixa arquivo temporário', () => {
    novo().bloquear('777', { nome: 'Beltrano' });

    expect(novo().estaBloqueado('777')).toBe(true);
    expect(fs.readdirSync(base).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const depois = novo();
    depois.desbloquear('777');
    expect(novo().estaBloqueado('777')).toBe(false);
  });

  it('arquivo corrompido não derruba o arranque', () => {
    fs.writeFileSync(path.join(base, 'bloqueios.json'), 'não é json');
    expect(novo().listarBloqueios()).toEqual([]);
  });
});

describe('buffer de eventos', () => {
  it('guarda só a janela e o teto, do mais antigo ao mais novo', () => {
    let t = 1_000_000;
    const b = criarBufferEventos({ janelaMs: 1000, max: 3, agora: () => t });
    for (const n of ['a', 'b', 'c', 'd']) {
      b.registrar(n, { sala: 's' });
      t += 100;
    }
    expect(b.recentes().map((e) => e.event)).toEqual(['b', 'c', 'd']);

    t += 5000;
    expect(b.recentes()).toEqual([]);
  });

  it('filtra e sanitiza o que guarda', () => {
    const b = criarBufferEventos();
    b.registrar('x', { sala: 's1', token: 'segredo' });
    b.registrar('y', { sala: 's2' });

    const [so] = b.recentes((e) => e.data.sala === 's1');
    expect(so.data.token).toBe('[REMOVIDO]');
    expect(b.recentes((e) => e.data.sala === 's1')).toHaveLength(1);
  });
});
