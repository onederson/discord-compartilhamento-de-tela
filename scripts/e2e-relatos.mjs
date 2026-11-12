#!/usr/bin/env node
/**
 * Teste ponta a ponta de relatos e denúncias, com Chrome real e sem proxy.
 *
 * Sobe o servidor com RELATOS_DIR numa pasta temporária nova e usa a interface
 * de verdade: o site (duas pessoas, uma transmite a câmera falsa e a outra
 * assiste e denuncia) e a aba de captura. Confere o que ficou gravado em disco.
 *
 * Não roda no CI: precisa de Chrome instalado (env CHROME_PATH) e leva ~1 min.
 *   npm run e2e:relatos
 */
/* global document, Image */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 3111;
const ORIGEM = `http://localhost:${PORTA}`;
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIR_LOG = process.env.E2E_LOG_DIR || path.join(os.tmpdir(), 'e2e-relatos');
const RELATOS_DIR = mkdtempSync(path.join(os.tmpdir(), 'e2e-relatos-dados-'));
const PASTA_RELATOS = path.join(RELATOS_DIR, 'relatos');
// O buffer de prints guarda um quadro a cada 5s; 16s garante pelo menos 3.
const ESPERA_PRINTS_MS = 16_000;

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

async function esperarAte(cond, ms, passo = 250) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await esperar(passo);
  }
  return false;
}

// --------------------------------------------------------------- servidor

async function subirServidor() {
  const filho = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORTA),
      PUBLIC_ORIGIN: ORIGEM,
      PERMITIR_WEB: '1',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_GUILD_ID: '',
      ADMIN_DISCORD_ID: '',
      DISCORD_WEBHOOK_RELATOS: '',
      RELATOS_DIR,
      DIAGNOSTICO_LOCAL: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  filho.stdout.on('data', (d) => log('servidor', d));
  filho.stderr.on('data', (d) => log('servidor:err', d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA}/api/health`);
      if (r.ok) return filho;
    } catch {
      /* ainda subindo */
    }
    await esperar(500);
  }
  throw new Error('servidor não respondeu em /api/health');
}

// ---------------------------------------------------------------- relatos

const idsEmDisco = () => {
  try {
    return readdirSync(PASTA_RELATOS);
  } catch {
    return [];
  }
};

/** Espera aparecer uma pasta de relato que não existia em `antes`. */
async function relatoNovo(antes) {
  let id = null;
  await esperarAte(() => {
    id = idsEmDisco().find((i) => !antes.includes(i)) ?? null;
    return id;
  }, 10_000);
  if (!id) return null;
  const pasta = path.join(PASTA_RELATOS, id);
  const bruto = readFileSync(path.join(pasta, 'relato.json'), 'utf8');
  return { id, pasta, bruto, json: JSON.parse(bruto), arquivos: readdirSync(pasta) };
}

// ------------------------------------------------------------------- main

const resultados = [];
function passo(nome, ok, detalhe = '') {
  resultados.push({ nome, ok, detalhe });
  log('teste', `${ok ? 'OK    ' : 'FALHOU'} ${nome} ${detalhe}`);
}

let filho;
let navegador;

async function principal() {
  filho = await subirServidor();
  log('teste', `servidor no ar; relatos em ${RELATOS_DIR}`);

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

  // Um contexto por pessoa: o site guarda a identidade por navegador.
  async function novaPagina(nome) {
    const ctx = await navegador.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    p.on('console', (m) => log(`${nome}:console`, `${m.type()} ${m.text()}`));
    p.on('pageerror', (e) => log(`${nome}:pageerror`, e.message));
    return p;
  }
  const dono = await novaPagina('dono');
  const captura = await novaPagina('captura');
  const outro = await novaPagina('denunciante');
  const lixo = await novaPagina('decodificador');
  const shot = (p, nome) =>
    p.screenshot({ path: path.join(DIR_LOG, `${nome}.png`) }).catch(() => {});

  // Tokens vistos nas respostas da API, para provar que não vazam no relato.
  const tokens = { donoViewer: null, broadcaster: null, outroViewer: null };
  let roomId = null;
  let shareUrl = null;
  dono.on('response', async (r) => {
    if (!r.url().includes('/api/rooms/create')) return;
    try {
      const j = await r.json();
      shareUrl = j.shareUrl;
      roomId = j.roomId;
      tokens.donoViewer = j.viewerToken;
      tokens.broadcaster = new URL(j.shareUrl).searchParams.get('t');
    } catch {
      /* ignorado */
    }
  });
  outro.on('response', async (r) => {
    if (!r.url().includes('/api/rooms/join')) return;
    try {
      tokens.outroViewer = (await r.json()).viewerToken;
    } catch {
      /* ignorado */
    }
  });

  // Dono cria a sala pela interface.
  await dono.goto(`${ORIGEM}/`, { waitUntil: 'domcontentloaded' });
  await dono.waitForFunction(() => !document.getElementById('newRoom')?.disabled, {
    timeout: 30_000,
  });
  await esperar(1000);
  await dono.click('#newRoom');
  await dono.type('#createName', 'e2e-relatos');
  await dono.click('#createGo');
  if (!(await esperarAte(() => shareUrl && roomId, 15_000))) {
    await shot(dono, 'falha-criar-sala');
    throw new Error('shareUrl não apareceu (ver falha-criar-sala.png)');
  }

  // Aba de captura liga a câmera falsa.
  await captura.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await captura.waitForSelector('#camera-start');
  await esperar(1000);
  await captura.click('#camera-start');

  // Segunda pessoa entra pelo link da sala e assiste (uma vez). O botão de
  // denunciar só existe em transmissão de outra pessoa.
  await outro.goto(`${ORIGEM}/?sala=${roomId}`, { waitUntil: 'domcontentloaded' });
  try {
    await outro.waitForSelector('.watch-prompt button', { timeout: 45_000 });
  } catch (e) {
    await shot(outro, 'falha-convite');
    await shot(captura, 'falha-convite-captura');
    throw new Error(`convite Assistir não apareceu: ${e.message}`, { cause: e });
  }
  await outro.bringToFront();
  await outro.click('.watch-prompt button');
  await outro.waitForSelector('.tile-report', { timeout: 30_000 });
  log('teste', `assistindo; aguardando ${ESPERA_PRINTS_MS / 1000}s para encher o buffer de prints`);
  await esperar(ESPERA_PRINTS_MS);

  // ------------------------------------------------------------ utilidades UI

  const texto = (p, sel) => p.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
  const desabilitado = (p, sel) => p.$eval(sel, (el) => el.disabled);
  const digitar = async (p, sel, valor) => {
    await p.focus(sel);
    await p.$eval(sel, (el) => el.select());
    await p.keyboard.press('Backspace');
    if (valor) await p.type(sel, valor);
  };
  const marcarCategoria = (cat) =>
    outro.evaluate(
      (c) => document.querySelector(`input[name="reportCat"][value="${c}"]`).click(),
      cat,
    );

  /** Abre o modal de denúncia pelo botão do tile, escolhe categoria e texto. */
  async function abrirDenuncia(cat, txt) {
    await outro.bringToFront();
    await outro.hover('.tile');
    await outro.click('.tile-report');
    await outro.waitForSelector('#reportModal:not([hidden])');
    await marcarCategoria(cat);
    if (txt) await digitar(outro, '#reportText', txt);
  }
  const fecharDenuncia = async () => {
    await outro.click('#reportCancel');
    await esperar(300);
  };

  // ---------------------------------------------------------------- 1. bug
  {
    const nome = '1 Atividade: reportar problema';
    const antes = idsEmDisco();
    await outro.click('#reportBug');
    await outro.waitForSelector('#bugModal:not([hidden])');
    await digitar(outro, '#bugText', 'abcde'); // 5 caracteres
    const curtoBloqueado = await desabilitado(outro, '#bugSend');
    const msg = 'E2E: o video travou ao trocar de aba e voltou sem som.';
    await digitar(outro, '#bugText', msg);
    const validoLiberado = !(await desabilitado(outro, '#bugSend'));
    await shot(outro, '1-bug-antes');
    await outro.click('#bugSend');
    const apareceu = await esperarAte(
      async () => /Código/.test(await texto(outro, '#bugStatus')),
      10_000,
    );
    const status = await texto(outro, '#bugStatus');
    await shot(outro, '1-bug-depois');
    const r = await relatoNovo(antes);
    const j = r?.json;
    const vazou = r
      ? Object.entries(tokens)
          .filter(([, t]) => t && r.bruto.includes(t))
          .map(([k]) => k)
      : [];
    const problemas = [];
    if (!curtoBloqueado) problemas.push('Enviar habilitado com 5 caracteres');
    if (!validoLiberado) problemas.push('Enviar não habilitou com texto válido');
    if (!apareceu) problemas.push(`sem código na tela (status="${status}")`);
    if (!r) problemas.push('relato.json não gravado');
    else {
      if (j.tipo !== 'bug') problemas.push(`tipo=${j.tipo}`);
      if (j.origem !== 'atividade') problemas.push(`origem=${j.origem}`);
      if (j.texto !== msg) problemas.push('texto diferente');
      if (!j.contexto?.caixaPreta) problemas.push('contexto sem caixaPreta');
      if (!Array.isArray(j.contexto?.streams)) problemas.push('contexto sem streams');
      if (!j.servidor?.eventos) problemas.push('sem servidor.eventos');
      if (!j.servidor?.sala) problemas.push('sem servidor.sala');
      if (!status.includes(r.id)) problemas.push('código na tela diferente do id gravado');
    }
    if (!tokens.outroViewer || !tokens.broadcaster) problemas.push('tokens não capturados');
    if (vazou.length) problemas.push(`token vazou no JSON: ${vazou.join(',')}`);
    passo(nome, !problemas.length, problemas.join('; ') || `id=${r?.id}`);
    await outro.click('#bugCancel');
    await esperar(300);
  }

  // Cada denúncia usa o mesmo buffer de prints.
  // ------------------------------------------------------- 2. violência/prints
  {
    const nome = '2 Atividade: denunciar com prints';
    const antes = idsEmDisco();
    await abrirDenuncia('violencia', 'E2E: conteudo violento na transmissao.');
    await shot(outro, '2-denuncia-antes');
    const liberado = !(await desabilitado(outro, '#reportSend'));
    await outro.click('#reportSend');
    const ok = await esperarAte(
      async () => /enviada/i.test(await texto(outro, '#reportStatus')),
      15_000,
    );
    await shot(outro, '2-denuncia-depois');
    const r = await relatoNovo(antes);
    const problemas = [];
    if (!liberado) problemas.push('Enviar desabilitado com categoria+texto');
    if (!ok) problemas.push(`sem confirmação (status="${await texto(outro, '#reportStatus')}")`);
    if (!r) problemas.push('relato.json não gravado');
    else {
      const j = r.json;
      if (j.tipo !== 'denuncia') problemas.push(`tipo=${j.tipo}`);
      if (j.categoria !== 'violencia') problemas.push(`categoria=${j.categoria}`);
      if (!j.alvo?.nome) problemas.push('alvo sem nome');
      const prints = r.arquivos.filter((a) => /^print-\d+\.jpg$/.test(a)).sort();
      if (prints.length < 2 || prints.length > 4) problemas.push(`${prints.length} prints`);
      for (const arq of prints) {
        const buf = readFileSync(path.join(r.pasta, arq));
        writeFileSync(path.join(DIR_LOG, `${r.id}-${arq}`), buf);
        if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff))
          problemas.push(`${arq} sem FFD8FF`);
        if (buf.length <= 2048) problemas.push(`${arq} com ${buf.length} bytes`);
        const w = await lixo.evaluate(
          (b64) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img.naturalWidth);
              img.onerror = () => resolve(0);
              img.src = `data:image/jpeg;base64,${b64}`;
            }),
          buf.toString('base64'),
        );
        if (!(w > 0 && w <= 960)) problemas.push(`${arq} largura=${w}`);
      }
      passo(
        nome,
        !problemas.length,
        problemas.join('; ') || `id=${r.id} alvo="${j.alvo.nome}" prints=${prints.length}`,
      );
    }
    if (!r) passo(nome, false, problemas.join('; '));
    await fecharDenuncia();
  }

  // ------------------------------------------------------------- 3. menores
  {
    const nome = '3 Atividade: denúncia de menores';
    const antes = idsEmDisco();
    await abrirDenuncia('menores');
    await shot(outro, '3-menores-antes');
    await outro.click('#reportSend');
    const ok = await esperarAte(
      async () => /enviada/i.test(await texto(outro, '#reportStatus')),
      15_000,
    );
    await shot(outro, '3-menores-depois');
    const r = await relatoNovo(antes);
    const problemas = [];
    if (!ok) problemas.push(`sem confirmação (status="${await texto(outro, '#reportStatus')}")`);
    if (!r) problemas.push('relato.json não gravado');
    else {
      if (r.arquivos.some((a) => /^print-.*\.jpg$/.test(a))) problemas.push('há print na pasta');
      if (r.json.urgente !== true) problemas.push(`urgente=${r.json.urgente}`);
    }
    passo(nome, !problemas.length, problemas.join('; ') || `id=${r?.id}`);
    await fecharDenuncia();
  }

  // ---------------------------------------------------------------- 4. outro
  {
    const nome = '4 Atividade: denúncia "outro"';
    const antes = idsEmDisco();
    await abrirDenuncia('outro');
    const semTexto = await desabilitado(outro, '#reportSend');
    await shot(outro, '4-outro-antes');
    await digitar(outro, '#reportText', 'E2E: motivo informado.');
    const comTexto = !(await desabilitado(outro, '#reportSend'));
    await outro.click('#reportSend');
    const ok = await esperarAte(
      async () => /enviada/i.test(await texto(outro, '#reportStatus')),
      15_000,
    );
    await shot(outro, '4-outro-depois');
    const r = await relatoNovo(antes);
    const problemas = [];
    if (!semTexto) problemas.push('Enviar habilitado sem texto');
    if (!comTexto) problemas.push('Enviar desabilitado com texto');
    if (!ok) problemas.push('sem confirmação');
    if (!r) problemas.push('relato.json não gravado');
    else if (r.json.categoria !== 'outro') problemas.push(`categoria=${r.json.categoria}`);
    passo(nome, !problemas.length, problemas.join('; ') || `id=${r?.id}`);
    await fecharDenuncia();
  }

  // ------------------------------------------------------ 5. aba de captura
  {
    const nome = '5 Captura: reportar problema';
    const antes = idsEmDisco();
    await captura.bringToFront();
    await captura.click('#bug-open');
    await captura.waitForSelector('#bug-modal:not([hidden])');
    await captura.type('#bug-text', 'E2E: relato vindo da aba de captura.');
    await shot(captura, '5-captura-antes');
    await captura.click('#bug-send');
    const ok = await esperarAte(
      async () => /Código/.test(await texto(captura, '#bug-status')),
      10_000,
    );
    await shot(captura, '5-captura-depois');
    const r = await relatoNovo(antes);
    const problemas = [];
    if (!ok) problemas.push(`sem código (status="${await texto(captura, '#bug-status')}")`);
    if (!r) problemas.push('relato.json não gravado');
    else {
      if (r.json.tipo !== 'bug') problemas.push(`tipo=${r.json.tipo}`);
      if (r.json.origem !== 'captura') problemas.push(`origem=${r.json.origem}`);
    }
    passo(nome, !problemas.length, problemas.join('; ') || `id=${r?.id}`);
    await captura.click('#bug-cancel');
  }

  // ---------------------------------------------------------------- 6. admin
  {
    const nome = '6 Admin: API sem login';
    const r = await fetch(`http://127.0.0.1:${PORTA}/api/admin/relatos`);
    passo(nome, r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  // ---------------------------------------------------------------- 7. limite
  {
    // A pessoa "denunciante" já enviou 4 (bug + 3 denúncias): o 5º passa e o 6º
    // é barrado. Os 400 de validação não contam.
    const nome = '7 Limite: 6º relato da mesma pessoa';
    await outro.bringToFront();
    const resultadosEnvio = [];
    for (let i = 5; i <= 6; i++) {
      await outro.click('#reportBug');
      await outro.waitForSelector('#bugModal:not([hidden])');
      await digitar(outro, '#bugText', `E2E: relato numero ${i} da mesma pessoa.`);
      await outro.click('#bugSend');
      await esperarAte(async () => (await texto(outro, '#bugStatus')).length > 0, 10_000);
      const status = await texto(outro, '#bugStatus');
      resultadosEnvio.push(status);
      await shot(outro, `7-limite-${i}o`);
      await outro.click('#bugCancel');
      await esperar(300);
    }
    const problemas = [];
    if (!/Código/.test(resultadosEnvio[0])) problemas.push(`5º recusado: "${resultadosEnvio[0]}"`);
    if (/Código/.test(resultadosEnvio[1])) problemas.push('6º foi aceito');
    else if (!/Muitos relatos/.test(resultadosEnvio[1]))
      problemas.push(`6º sem a mensagem do servidor: "${resultadosEnvio[1]}"`);
    passo(nome, !problemas.length, problemas.join('; ') || `6º: "${resultadosEnvio[1]}"`);
  }
}

function tabela() {
  const linhas = [['passo', 'resultado', 'detalhe']];
  for (const r of resultados) linhas.push([r.nome, r.ok ? 'passou' : 'FALHOU', r.detalhe]);
  const larg = linhas[0].map((_, i) => Math.max(...linhas.map((l) => String(l[i]).length)));
  return linhas.map((l) => l.map((c, i) => String(c).padEnd(larg[i])).join(' | ')).join('\n');
}

let codigo;
try {
  await principal();
  log('teste', '\n' + tabela());
  codigo = resultados.length === 7 && resultados.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  log('teste', `ERRO: ${err.stack ?? err}`);
  if (resultados.length) log('teste', '\n' + tabela());
  codigo = 2;
} finally {
  await navegador?.close().catch(() => {});
  filho?.kill();
  log('teste', `log completo em ${path.join(DIR_LOG, 'e2e.log')}; dados em ${RELATOS_DIR}`);
  logStream.end();
}
process.exit(codigo);
