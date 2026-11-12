import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizarDados } from '../scripts/diagnostics.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DIAS_PRINTS = 30;
export const MAX_RELATOS = 500;
export const JANELA_EVENTOS_MS = 15 * 60 * 1000;
export const MAX_EVENTOS = 5000;

const DIA_MS = 24 * 60 * 60 * 1000;

// O id vira nome de pasta e chega pela URL do painel: a regex estrita é o que
// impede "../" de sair de .dados/relatos. Nada é montado antes de passar por ela.
const ID_RELATO = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{4}$/;

const TIPOS = new Set(['bug', 'denuncia']);

/** Escrita atômica: quem lê nunca vê o arquivo pela metade, nem após uma queda de energia. */
function gravarJson(arquivo, valor) {
  const temporario = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(valor, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporario, arquivo);
}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return null;
  }
}

/** O instante gravado no próprio id, em vez do mtime da pasta, que muda por qualquer cópia. */
function instanteDoId(id) {
  const m = ID_RELATO.exec(id);
  if (!m) return null;
  const [, a, mes, d, h, mi, s] = m;
  return Date.UTC(+a, +mes - 1, +d, +h, +mi, +s);
}

function idNovo(agora) {
  const p = new Date(agora).toISOString(); // 2026-11-09T12:30:45.000Z
  const data = p.slice(0, 10).replaceAll('-', '');
  const hora = p.slice(11, 19).replaceAll(':', '');
  return `${data}-${hora}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Relatos e bloqueios, em disco.
 *
 * A pasta base é injetável para os testes não encostarem na `.dados` de verdade.
 * Tudo aqui é síncrono: são arquivos pequenos, poucos por hora, e a ordem das
 * escritas fica óbvia.
 */
export function criarRelatos({
  base = path.join(RAIZ, '.dados'),
  agora = () => Date.now(),
  maxRelatos = MAX_RELATOS,
  diasPrints = DIAS_PRINTS,
} = {}) {
  const pastaRelatos = path.join(base, 'relatos');
  const arquivoBloqueios = path.join(base, 'bloqueios.json');

  const pastaDe = (id) => path.join(pastaRelatos, id);

  function idsExistentes() {
    try {
      return fs.readdirSync(pastaRelatos).filter((nome) => ID_RELATO.test(nome));
    } catch {
      return [];
    }
  }

  /** Prints velhos saem, o texto fica: o relato continua útil sem a imagem. */
  function aplicarRetencao() {
    const ids = idsExistentes().sort();
    const limiteImagens = agora() - diasPrints * DIA_MS;

    for (const id of ids) {
      if (instanteDoId(id) >= limiteImagens) continue;
      try {
        for (const nome of fs.readdirSync(pastaDe(id))) {
          if (/^print-\d+\.jpg$/.test(nome))
            fs.rmSync(path.join(pastaDe(id), nome), { force: true });
        }
      } catch {
        // Pasta sumiu no meio do caminho; nada a limpar.
      }
    }

    // Ids ordenam por data, então os primeiros da lista são os mais antigos.
    for (const id of ids.slice(0, Math.max(0, ids.length - maxRelatos))) {
      fs.rmSync(pastaDe(id), { recursive: true, force: true });
    }
  }

  /**
   * @param {'bug'|'denuncia'} tipo
   * @param {object} dados campos do relato (texto, quem, sala, ...)
   * @param {Buffer[]} imagens JPEGs já validados por quem chama
   * @returns {string} id do relato
   */
  function salvar(tipo, dados, imagens = []) {
    if (!TIPOS.has(tipo)) throw new Error(`tipo de relato inválido: ${tipo}`);

    fs.mkdirSync(pastaRelatos, { recursive: true });

    let id;
    do {
      id = idNovo(agora());
    } while (fs.existsSync(pastaDe(id)));
    fs.mkdirSync(pastaDe(id), { mode: 0o700 });

    imagens.forEach((imagem, i) => {
      fs.writeFileSync(path.join(pastaDe(id), `print-${i + 1}.jpg`), imagem, { mode: 0o600 });
    });

    const relato = {
      id,
      tipo,
      criadoEm: new Date(agora()).toISOString(),
      status: 'aberto',
      resolucao: null,
      ...dados,
      prints: imagens.length,
    };
    gravarJson(path.join(pastaDe(id), 'relato.json'), relato);

    aplicarRetencao();
    return id;
  }

  /** O relato inteiro, ou null para id inválido ou inexistente. */
  function ler(id) {
    if (typeof id !== 'string' || !ID_RELATO.test(id)) return null;
    return lerJson(path.join(pastaDe(id), 'relato.json'));
  }

  /** Resumo dos mais recentes primeiro, sem o contexto pesado. */
  function listar({ tipo, status, limite = 100 } = {}) {
    const resumos = [];
    for (const id of idsExistentes().sort().reverse()) {
      const r = ler(id);
      if (!r) continue;
      if (tipo && r.tipo !== tipo) continue;
      if (status && r.status !== status) continue;
      resumos.push({
        id: r.id,
        tipo: r.tipo,
        criadoEm: r.criadoEm,
        status: r.status,
        categoria: r.categoria ?? null,
        urgente: Boolean(r.urgente),
        origem: r.origem ?? null,
        previa: String(r.texto ?? '').slice(0, 140),
        quem: r.quem?.nome ?? null,
        alvo: r.alvo?.nome ?? null,
        prints: r.prints ?? 0,
      });
      if (resumos.length >= limite) break;
    }
    return resumos;
  }

  /** Caminho do print `n` (1..), ou null se o id for inválido ou o arquivo não existir. */
  function caminhoPrint(id, n) {
    if (typeof id !== 'string' || !ID_RELATO.test(id)) return null;
    const numero = Number(n);
    if (!Number.isInteger(numero) || numero < 1 || numero > 99) return null;
    const arquivo = path.join(pastaDe(id), `print-${numero}.jpg`);
    return fs.existsSync(arquivo) ? arquivo : null;
  }

  function marcarResolvido(id, nota, admin) {
    const relato = ler(id);
    if (!relato) return null;
    relato.status = 'resolvido';
    relato.resolucao = {
      em: new Date(agora()).toISOString(),
      nota: String(nota ?? '')
        .trim()
        .slice(0, 500),
      por: String(admin ?? '').slice(0, 64),
    };
    gravarJson(path.join(pastaDe(id), 'relato.json'), relato);
    return relato;
  }

  // ---------------------------------------------------------------- bloqueios

  // Carregado uma vez: estaBloqueado roda a cada conexão de transmissão e não
  // deve ir ao disco por isso.
  const bloqueios = new Map();
  for (const item of lerJson(arquivoBloqueios) ?? []) {
    if (item && typeof item.uid === 'string') bloqueios.set(item.uid, item);
  }

  const salvarBloqueios = () => {
    fs.mkdirSync(base, { recursive: true });
    gravarJson(arquivoBloqueios, [...bloqueios.values()]);
  };

  const estaBloqueado = (uid) => bloqueios.has(String(uid));

  function bloquear(uid, { nome = '', motivo = '', por = '' } = {}) {
    const registro = {
      uid: String(uid),
      nome: String(nome).slice(0, 64),
      motivo: String(motivo).slice(0, 300),
      por: String(por).slice(0, 64),
      em: new Date(agora()).toISOString(),
    };
    bloqueios.set(registro.uid, registro);
    salvarBloqueios();
    return registro;
  }

  function desbloquear(uid) {
    const existia = bloqueios.delete(String(uid));
    if (existia) salvarBloqueios();
    return existia;
  }

  const listarBloqueios = () => [...bloqueios.values()];

  return {
    base,
    salvar,
    ler,
    listar,
    caminhoPrint,
    marcarResolvido,
    estaBloqueado,
    bloquear,
    desbloquear,
    listarBloqueios,
  };
}

/**
 * Os últimos eventos do diagnóstico, só em memória.
 *
 * Existe para o relato carregar o que o servidor viu pouco antes, mesmo com o
 * diagnóstico em disco desligado. Anel de tamanho fixo: o custo por evento é
 * constante e a memória não cresce com o tempo de uso.
 */
export function criarBufferEventos({
  janelaMs = JANELA_EVENTOS_MS,
  max = MAX_EVENTOS,
  agora = () => Date.now(),
} = {}) {
  const anel = new Array(max);
  let proximo = 0;
  let total = 0;

  function registrar(evento, dados = {}) {
    const nome = String(evento)
      .replace(/[^a-z0-9_.-]/gi, '')
      .slice(0, 64);
    if (!nome) return;
    // Mesma saneada do arquivo: o buffer chega a um relato que o admin lê.
    anel[proximo] = {
      t: agora(),
      at: new Date(agora()).toISOString(),
      event: nome,
      data: sanitizarDados(dados),
    };
    proximo = (proximo + 1) % max;
    total = Math.min(total + 1, max);
  }

  /** Do mais antigo ao mais novo, dentro da janela e com o filtro. */
  function recentes(filtro = () => true) {
    const corte = agora() - janelaMs;
    const saida = [];
    for (let i = 0; i < total; i++) {
      const item = anel[(proximo - total + i + max) % max];
      if (item.t >= corte && filtro(item))
        saida.push({ at: item.at, event: item.event, data: item.data });
    }
    return saida;
  }

  return { registrar, recentes };
}
