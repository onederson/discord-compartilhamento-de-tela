#!/usr/bin/env node
/**
 * Teste ponta a ponta de resiliência da conexão, com Chrome real.
 *
 * Sobe o servidor, um proxy TCP que sabe cortar/congelar conexões por tipo
 * (transmissor, controle, espectador), um espectador (site) e uma aba de
 * captura com a câmera falsa do Chrome. Depois provoca falhas de rede e mede
 * quanto a imagem leva para voltar SEM o espectador clicar em "Assistir".
 *
 * Não roda no CI: precisa de Chrome instalado (env CHROME_PATH) e leva minutos.
 *   npm run e2e:resiliencia
 */
/* global document */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA_SERVIDOR = 3101;
const PORTA_PROXY = 3102;
const ORIGEM = `http://localhost:${PORTA_PROXY}`;
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIR_LOG = process.env.E2E_LOG_DIR || path.join(os.tmpdir(), 'e2e-resiliencia');
const TIPOS = ['transmissor', 'controle', 'espectador'];
const TETO_VOLTA_MS = 90_000;
const LIMITE_APROVACAO_MS = 45_000;
const JANELA_VIVA_MS = 2_000;

mkdirSync(DIR_LOG, { recursive: true });
const logStream = createWriteStream(path.join(DIR_LOG, 'e2e.log'), { flags: 'w' });
const t0Global = Date.now();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = () => ((Date.now() - t0Global) / 1000).toFixed(1).padStart(7);

function log(origem, texto) {
  const linha = `[${rel()}s] [${origem}] ${String(texto).trimEnd()}`;
  logStream.write(linha + '\n');
  if (origem === 'teste') console.log(linha);
}

// ------------------------------------------------------------------ proxy

function classificar(cabecalho) {
  const m = /^[A-Z]+ (\S+)/.exec(cabecalho);
  const alvo = m?.[1] ?? '';
  if (!alvo.startsWith('/ws')) return 'http';
  const q = new URLSearchParams(alvo.split('?')[1] ?? '');
  if (q.has('fonte')) return 'transmissor';
  if (q.get('modo') === 'controle') return 'controle';
  return 'espectador';
}

function criarProxy() {
  const conexoes = new Set(); // { tipo, cliente, servidor, congelada }
  const bloqueados = new Set();
  const novas = { transmissor: 0, controle: 0, espectador: 0, http: 0 };
  let congelados = new Set();

  const server = net.createServer((cliente) => {
    const conn = { tipo: null, cliente, servidor: null, congelada: false };
    conexoes.add(conn);
    cliente.on('error', () => {});
    cliente.once('close', () => {
      conexoes.delete(conn);
      conn.servidor?.destroy();
    });
    cliente.once('data', (primeiro) => {
      conn.tipo = classificar(primeiro.toString('latin1', 0, 512));
      novas[conn.tipo]++;
      if (bloqueados.has(conn.tipo)) return cliente.destroy();
      const servidor = net.connect(PORTA_SERVIDOR, '127.0.0.1');
      conn.servidor = servidor;
      servidor.on('error', () => cliente.destroy());
      servidor.once('close', () => cliente.destroy());
      servidor.write(primeiro);
      cliente.on('data', (d) => {
        if (!conn.congelada) servidor.write(d);
      });
      servidor.on('data', (d) => {
        if (!conn.congelada) cliente.write(d);
      });
    });
  });

  return {
    iniciar: () => new Promise((r) => server.listen(PORTA_PROXY, '127.0.0.1', r)),
    fechar: () => {
      for (const c of conexoes) c.cliente.destroy();
      server.close();
    },
    /** Destrói os sockets desses tipos: o navegador vê 1006. */
    cortar(tipos) {
      for (const c of [...conexoes]) if (tipos.includes(c.tipo)) c.cliente.destroy();
    },
    /** Para de repassar nos dois sentidos, sem fechar (conexão meio-aberta). */
    congelar(tipos) {
      for (const c of conexoes)
        if (tipos.includes(c.tipo) && c.servidor) {
          c.congelada = true;
          congelados.add(c);
        }
    },
    /** Encerra as conexões congeladas (os dados retidos são descartados). */
    descongelar() {
      for (const c of congelados) c.cliente.destroy();
      congelados = new Set();
    },
    bloquearNovas(tipos, ligado) {
      for (const t of tipos) ligado ? bloqueados.add(t) : bloqueados.delete(t);
    },
    contagem: () => ({ ...novas }),
  };
}

// --------------------------------------------------------------- servidor

async function subirServidor() {
  const filho = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORTA_SERVIDOR),
      PUBLIC_ORIGIN: ORIGEM,
      PERMITIR_WEB: '1',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_GUILD_ID: '',
      ADMIN_DISCORD_ID: '',
      DIAGNOSTICO_LOCAL: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  filho.stdout.on('data', (d) => log('servidor', d));
  filho.stderr.on('data', (d) => log('servidor:err', d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA_SERVIDOR}/api/health`);
      if (r.ok) return filho;
    } catch {
      /* ainda subindo */
    }
    await esperar(500);
  }
  throw new Error('servidor não respondeu em /api/health');
}

// ------------------------------------------------------------- imagem viva

/** Amostra um hash do canvas do stream a cada 500ms e guarda quando mudou. */
function monitorarImagem(pagina) {
  const estado = {
    ultimaMudanca: 0,
    ultimoHash: null,
    parado: false,
    paradoDesde: null,
    voltouEm: null,
  };
  const timer = setInterval(async () => {
    let hash = null;
    try {
      hash = await pagina.evaluate(() => {
        const canvas = [...document.querySelectorAll('canvas')].sort(
          (a, b) => b.width * b.height - a.width * a.height,
        )[0];
        if (!canvas || !canvas.width) return null;
        const mini = document.createElement('canvas');
        mini.width = 32;
        mini.height = 32;
        const ctx = mini.getContext('2d');
        ctx.drawImage(canvas, 0, 0, 32, 32);
        const d = ctx.getImageData(0, 0, 32, 32).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619) >>> 0;
        return h;
      });
    } catch {
      /* página navegando */
    }
    const agora = Date.now();
    if (hash !== null && hash !== estado.ultimoHash) {
      estado.ultimoHash = hash;
      estado.ultimaMudanca = agora;
      if (estado.parado) {
        estado.parado = false;
        estado.voltouEm = agora;
        log(
          'imagem',
          `VOLTOU (parada desde +${((estado.paradoDesde - t0Global) / 1000).toFixed(1)}s)`,
        );
      }
    } else if (
      !estado.parado &&
      estado.ultimaMudanca &&
      agora - estado.ultimaMudanca > JANELA_VIVA_MS
    ) {
      estado.parado = true;
      estado.paradoDesde = estado.ultimaMudanca;
      estado.voltouEm = null;
      log('imagem', 'PAROU (sem mudanca ha 2s)');
    }
  }, 500);
  return {
    estado,
    viva: () => estado.ultimaMudanca > 0 && Date.now() - estado.ultimaMudanca <= JANELA_VIVA_MS,
    parar: () => clearInterval(timer),
  };
}

async function esperarAte(cond, ms, passo = 250) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await esperar(passo);
  }
  return false;
}

// ------------------------------------------------------------------- main

const resultados = [];
let filho;
let proxy;
let navegador;
// O teste clica em "Assistir" uma única vez; qualquer outro clique seria trapaça.
let cliques = 0;

async function principal() {
  filho = await subirServidor();
  log('teste', 'servidor no ar');
  proxy = criarProxy();
  await proxy.iniciar();

  navegador = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--no-sandbox',
    ],
  });
  const ctxEsp = await navegador.createBrowserContext();
  const ctxTx = await navegador.createBrowserContext();
  const esp = await ctxEsp.newPage();
  const tx = await ctxTx.newPage();
  for (const [nome, p] of [
    ['espectador', esp],
    ['captura', tx],
  ]) {
    await p.setViewport({ width: 1280, height: 800 });
    p.on('console', (m) => log(`${nome}:console`, `${m.type()} ${m.text()}`));
    p.on('pageerror', (e) => log(`${nome}:pageerror`, e.message));
  }
  const shot = (p, nome) =>
    p.screenshot({ path: path.join(DIR_LOG, `${nome}.png`) }).catch(() => {});

  // Espectador cria a sala pela interface; o shareUrl vem da resposta da API.
  let shareUrl = null;
  esp.on('response', async (r) => {
    if (r.url().includes('/api/rooms/create')) {
      try {
        shareUrl = (await r.json()).shareUrl;
      } catch {
        /* ignorado */
      }
    }
  });
  await esp.goto(`${ORIGEM}/`, { waitUntil: 'domcontentloaded' });
  await esp.waitForFunction(() => !document.getElementById('newRoom')?.disabled, {
    timeout: 30_000,
  });
  await esperar(1000);
  await esp.click('#newRoom');
  await esp.type('#createName', 'e2e');
  await esp.click('#createGo');
  if (!(await esperarAte(() => shareUrl, 15_000))) {
    await shot(esp, 'falha-criar-sala');
    throw new Error('shareUrl não apareceu (ver falha-criar-sala.png)');
  }
  log('teste', `shareUrl=${shareUrl}`);

  // Aba de captura liga a câmera.
  await tx.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await tx.waitForSelector('#camera-start');
  await esperar(1000);
  await tx.click('#camera-start');
  const statusCaptura = () =>
    tx
      .evaluate(
        () =>
          `camera="${document.getElementById('camera-status')?.textContent ?? ''}" controle="${
            document.getElementById('control-status')?.textContent ?? ''
          }" pagina="${document.getElementById('pageStatus')?.textContent ?? ''}"`,
      )
      .catch((e) => `(erro ao ler: ${e.message})`);

  // Único clique em Assistir.
  try {
    await esp.waitForSelector('.watch-prompt button', { timeout: 30_000 });
  } catch (e) {
    await shot(esp, 'falha-convite');
    await shot(tx, 'falha-convite-captura');
    log('teste', `captura: ${await statusCaptura()}`);
    throw new Error(`convite Assistir não apareceu: ${e.message}`, { cause: e });
  }
  await esp.click('.watch-prompt button');
  cliques = 1;

  const imagem = monitorarImagem(esp);
  if (!(await esperarAte(imagem.viva, 30_000))) {
    await shot(esp, 'falha-imagem-inicial');
    throw new Error('imagem inicial nunca ficou viva');
  }
  log('teste', 'imagem inicial viva');
  await shot(esp, 'inicio');

  const conviteVisivel = () =>
    esp.evaluate(() => Boolean(document.querySelector('.watch-prompt button')));

  async function cenario(nome, falha) {
    if (!(await esperarAte(imagem.viva, 60_000))) {
      resultados.push({ nome, volta: null, nota: 'imagem não estava viva ao iniciar' });
      return;
    }
    await esperar(3000);
    const antes = proxy.contagem();
    const cliquesAntes = cliques;
    const t0 = Date.now();
    imagem.estado.voltouEm = null;
    log('teste', `=== ${nome}: início da falha ===`);
    await falha();
    // Fase 1: espera a imagem parar (ou 8s sem parar = queda invisível).
    await esperarAte(() => imagem.estado.parado || imagem.estado.voltouEm, 8000);
    // Fase 2: espera voltar.
    const voltou = await esperarAte(
      () =>
        imagem.estado.voltouEm ||
        (!imagem.estado.parado && imagem.viva() && Date.now() - t0 > 8000),
      Math.max(1000, TETO_VOLTA_MS - (Date.now() - t0)),
    );
    const paradaVisivel = Boolean(
      imagem.estado.paradoDesde && imagem.estado.paradoDesde >= t0 - 3000,
    );
    const volta = voltou
      ? paradaVisivel && imagem.estado.voltouEm
        ? imagem.estado.voltouEm - t0
        : 0
      : null;
    const convite = await conviteVisivel();
    const depois = proxy.contagem();
    const novas = Object.fromEntries(TIPOS.map((t) => [t, depois[t] - antes[t]]));
    const status = await statusCaptura();
    log('teste', `=== ${nome}: volta=${volta}ms convite=${convite} captura: ${status}`);
    await shot(esp, nome.split(' ')[0]);
    resultados.push({ nome, volta, novas, cliques: cliques - cliquesAntes, convite, status });
  }

  await cenario('S1 corte rapido', async () => proxy.cortar(TIPOS));
  await cenario('S2 queda 20s', async () => {
    proxy.bloquearNovas(TIPOS, true);
    proxy.cortar(TIPOS);
    await esperar(20_000);
    proxy.bloquearNovas(TIPOS, false);
  });
  await cenario('S3 espectador meio-aberto', async () => proxy.congelar(['espectador']));
  proxy.descongelar();
  await cenario('S4 transmissor meio-aberto', async () => proxy.congelar(['transmissor']));
  proxy.descongelar();
  await cenario('S5 queda longa 75s', async () => {
    proxy.bloquearNovas(TIPOS, true);
    proxy.cortar(TIPOS);
    await esperar(75_000);
    proxy.bloquearNovas(TIPOS, false);
  });

  imagem.parar();
}

function aprovado(r) {
  return r.volta !== null && r.volta !== undefined && r.volta <= LIMITE_APROVACAO_MS && !r.cliques;
}

function tabela() {
  const linhas = [['cenario', 'resultado', 'tempoAteVoltarMs', 'novas tx/ctl/esp', 'convite']];
  for (const r of resultados) {
    const res = r.nome.startsWith('S5')
      ? `registro (${r.volta === null ? 'não voltou' : 'voltou'})`
      : aprovado(r)
        ? 'passou'
        : 'FALHOU';
    const n = r.novas ? `${r.novas.transmissor}/${r.novas.controle}/${r.novas.espectador}` : '-';
    linhas.push([r.nome, res, r.volta ?? `>${TETO_VOLTA_MS}`, n, r.convite ? 'sim' : 'não']);
  }
  const larg = linhas[0].map((_, i) => Math.max(...linhas.map((l) => String(l[i]).length)));
  return linhas.map((l) => l.map((c, i) => String(c).padEnd(larg[i])).join(' | ')).join('\n');
}

let codigo;
try {
  await principal();
  log('teste', '\n' + tabela());
  for (const r of resultados) log('teste', `${r.nome}: captura ${r.status}`);
  const obrigatorios = resultados.filter((r) => !r.nome.startsWith('S5'));
  codigo = obrigatorios.length === 4 && obrigatorios.every(aprovado) ? 0 : 1;
} catch (err) {
  log('teste', `ERRO: ${err.stack ?? err}`);
  codigo = 2;
} finally {
  await navegador?.close().catch(() => {});
  proxy?.fechar();
  filho?.kill();
  log('teste', `log completo em ${path.join(DIR_LOG, 'e2e.log')}`);
  logStream.end();
}
process.exit(codigo);
