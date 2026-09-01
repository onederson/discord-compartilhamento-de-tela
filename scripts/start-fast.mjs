/**
 * Um comando só, do zero ao ar: configura se precisar, monta o site, abre o
 * túnel e sobe o servidor.
 *
 * A diferença para o `npm run dev` não é técnica, é de público. O `dev` supõe
 * que a pessoa já sabe o que tem configurado e o que falta. Aqui a pergunta
 * "e agora?" não deveria existir: ou faltam as credenciais, e ele as pede na
 * hora, ou está tudo pronto, e ele só confirma antes de subir.
 *
 * Sem configuração usa um túnel descartável; com `TUNEL_CONFIG`, respeita o
 * endereço fixo criado pelo assistente. Se o processo do Cloudflare cair, ele
 * é supervisionado e volta com backoff sem exigir outra janela.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { lerEnv, gravarEnv, terminalLimpo, cor } from './env.mjs';
import { createDiagnosticLogger, diagnosticoLigado, enviarDiagnostico } from './diagnostics.mjs';
import { executarBuildComReparo } from './build-recovery.mjs';
import { garantirEntryPoint, contarEntryPoint } from './entry-point.mjs';
import { atrasoReinicio } from './reinicio.mjs';
import { abrirTunel } from './tunel.mjs';
import { RAIZ, VITE, acompanhar, derrubar, encerrarFilho, encerrandoAgora } from './processos.mjs';
import { atualizacaoLigada, atualizarCheckout, mensagemAtualizacao } from './updater.mjs';

const linha = (t = '') => console.log(t);
const nota = (t) => linha(`${cor.fraco}${t}${cor.fim}`);
const erro = (t) => linha(`${cor.vermelho}  ${t}${cor.fim}`);

// ---------------------------------------------------------------- configurar

const ambienteInicial = lerEnv();
const diagnostico = createDiagnosticLogger({
  raiz: RAIZ,
  habilitado: diagnosticoLigado(ambienteInicial.DIAGNOSTICO_LOCAL),
});
diagnostico.log('startup', {
  terminalLimpo: terminalLimpo(ambienteInicial),
  discordConfigured: Boolean(
    ambienteInicial.DISCORD_CLIENT_ID && ambienteInicial.DISCORD_CLIENT_SECRET,
  ),
  uploadEnabled: Boolean(ambienteInicial.DIAGNOSTICO_UPLOAD_URL),
});

const resultadoAtualizacao = atualizarCheckout({
  raiz: RAIZ,
  habilitada: atualizacaoLigada(ambienteInicial.ATUALIZACAO_AUTOMATICA),
});
const atualizacaoAplicada = resultadoAtualizacao.status === 'atualizada';
diagnostico.log('update.check', resultadoAtualizacao);
const avisoAtualizacao = mensagemAtualizacao(resultadoAtualizacao);
if (avisoAtualizacao) nota(`  ${avisoAtualizacao}`);

if (ambienteInicial.DIAGNOSTICO_UPLOAD_URL) {
  const envio = await enviarDiagnostico({
    arquivo: diagnostico.arquivo,
    url: ambienteInicial.DIAGNOSTICO_UPLOAD_URL,
    token: ambienteInicial.DIAGNOSTICO_UPLOAD_TOKEN,
  });
  diagnostico.log('diagnostic.upload', { status: envio.status, httpStatus: envio.httpStatus });
}

const rl = createInterface({ input: stdin, output: stdout });

async function perguntar(rotulo, { padrao = '', valida } = {}) {
  for (;;) {
    const dica = padrao ? ` ${cor.fraco}[${encurtar(padrao)}]${cor.fim}` : '';
    const resposta = (await rl.question(`  ${cor.azul}${rotulo}${cor.fim}${dica}: `)).trim();
    const valor = resposta || padrao;

    const problema = valida?.(valor);
    if (!problema) return valor;
    erro(problema);
  }
}

const encurtar = (t) => (t.length > 24 ? `${t.slice(0, 10)}…${t.slice(-6)}` : t);

/**
 * Pede só o Client ID e o Secret.
 *
 * O `npm run configurar` também pergunta o endereço público, e aqui isso seria
 * pedir o que o próprio comando vai descobrir daqui a dez segundos — o túnel
 * sobe logo depois e grava o endereço sozinho.
 */
async function configurar(atual) {
  linha();
  linha(`${cor.forte}  Credenciais do Discord${cor.fim}`);
  linha();
  linha(`  Abra:  ${cor.forte}https://discord.com/developers/applications${cor.fim}`);
  linha();
  nota('  Clique em "New Application", dê um nome e confirme.');
  nota('  Depois, no menu da esquerda, clique em "OAuth2" — os dois valores');
  nota('  estão nessa página. Para ver o Secret, use "Reset Secret";');
  nota('  ele só aparece uma vez.');
  linha();

  const DISCORD_CLIENT_ID = await perguntar('Client ID', {
    padrao: atual.DISCORD_CLIENT_ID,
    valida: (v) =>
      /^[0-9]{15,21}$/.test(v)
        ? null
        : 'O Client ID é só números (uns 19). Confira e cole de novo.',
  });

  const DISCORD_CLIENT_SECRET = await perguntar('Client Secret', {
    padrao: atual.DISCORD_CLIENT_SECRET,
    valida: (v) =>
      v.length >= 20 ? null : 'O Secret é bem mais longo que isso. Confira e cole de novo.',
  });

  gravarEnv({
    // Preservado quando já existe: trocá-lo desconectaria todo mundo que está
    // numa sala agora.
    SESSION_SECRET: atual.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
  });

  linha(`\n${cor.verde}  Guardado.${cor.fim}`);
  nota('  O que falta colar no portal do Discord aparece junto com o endereço,');
  nota('  logo abaixo — ele só existe depois que o túnel sobe.');
}

// --------------------------------------------------------------------- menu

linha();
linha(`${cor.forte}  Sala de Tela${cor.fim}`);

const atual = ambienteInicial;
const configurado = Boolean(atual.DISCORD_CLIENT_ID && atual.DISCORD_CLIENT_SECRET);
const saidaLimpa = terminalLimpo(atual);

/**
 * Sem terminal de verdade não há como perguntar nada.
 *
 * O `readline` simplesmente nunca resolve quando o stdin fecha, e o Node morre
 * com um "unsettled top-level await" que não diz nada a ninguém. Melhor
 * reconhecer a situação: sem configuração, avisa e sai; com ela, segue direto,
 * que é o comportamento útil para quem chama isto de dentro de outro script.
 */
const interativo = Boolean(stdin.isTTY);

if (!configurado && !interativo) {
  linha();
  erro('Faltam as credenciais do Discord, e não há terminal para perguntar.');
  nota('  Rode "npm run start:fast" direto no terminal, ou "npm run configurar".');
  linha();
  rl.close();
  process.exit(1);
}

if (!configurado) {
  nota('  Primeira vez por aqui — vamos configurar o Discord.');
  nota('  (Ctrl+C a qualquer momento; nada se perde.)');
  await configurar(atual);
} else if (!interativo) {
  nota(`  Aplicação ${atual.DISCORD_CLIENT_ID} — subindo direto (sem terminal para o menu).`);
} else {
  linha();
  linha(`    ${cor.forte}1${cor.fim}  Continuar`);
  nota(`       Sobe tudo agora, com a aplicação ${atual.DISCORD_CLIENT_ID}.`);
  linha();
  linha(`    ${cor.forte}2${cor.fim}  Configurar de novo`);
  nota('       Trocar o Client ID e o Secret.');
  linha();

  const escolha = await perguntar('Escolha (1 ou 2)', {
    padrao: '1',
    valida: (v) => (v === '1' || v === '2' ? null : 'Digite 1 ou 2.'),
  });

  if (escolha === '2') await configurar(atual);
}

rl.close();

// -------------------------------------------------------------- entry point

// Fora do `configurar()` de propósito: o menu tem um "Continuar" que pula a
// configuração inteira, e junto com ela ia embora a única checagem do comando
// que coloca a atividade no seletor do Discord. Uma aplicação sem
// PRIMARY_ENTRY_POINT não aparece lá — sem erro no portal, sem erro aqui, e
// nada na tela ligando uma coisa à outra. Quem já tinha as credenciais no
// `.env` nunca passava por esta linha.
//
// Conferir a cada subida é barato e idempotente: o `garantirEntryPoint` lê a
// lista antes e só cria o que falta. As credenciais são relidas porque o
// `configurar()` pode tê-las acabado de trocar, e `atual` é de antes disso.
const credenciais = lerEnv();
contarEntryPoint(
  await garantirEntryPoint(credenciais.DISCORD_CLIENT_ID, credenciais.DISCORD_CLIENT_SECRET),
);

// -------------------------------------------------------------------- build

linha();
nota('  Montando o site…');

const executarBuild = () =>
  spawnSync(process.execPath, [VITE, 'build'], {
    cwd: path.join(RAIZ, 'client'),
    encoding: 'utf8',
    windowsHide: true,
  });

const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidato) => candidato && fs.existsSync(candidato));

const instalarDependencias = (mensagem) => {
  nota(mensagem);
  if (!npmCli) {
    return {
      status: 1,
      stderr:
        'O npm portátil não foi encontrado junto do Node.js. Execute INICIAR.bat (Windows) ou INICIAR.sh (Linux) novamente.',
    };
  }
  return spawnSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
    cwd: RAIZ,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      npm_config_cache: path.join(RAIZ, '.cache', 'npm'),
    },
  });
};

const repararDependencias = () =>
  instalarDependencias('  O primeiro build falhou. Reparando as dependências automaticamente…');

if (atualizacaoAplicada) {
  const dependenciasAtualizadas = instalarDependencias(
    '  Sincronizando as dependências da versão nova…',
  );
  if (dependenciasAtualizadas.status !== 0) {
    diagnostico.log('update.dependencies-failed', {
      detail: String(dependenciasAtualizadas.stderr || dependenciasAtualizadas.stdout).slice(
        -2_000,
      ),
    });
    erro('A versão nova foi baixada, mas não foi possível sincronizar suas dependências.');
    nota('  Feche a janela e abra o iniciador novamente; seus arquivos não foram apagados.');
    process.exit(1);
  }
}

const build = executarBuildComReparo({ build: executarBuild, reparar: repararDependencias });

if (!build.ok) {
  diagnostico.log('build.failed', {
    repaired: build.reparado,
    detail: build.detalhes.slice(-2_000),
  });
  const detalhes = build.detalhes.slice(-6000) || 'O processo terminou sem informar a causa.';
  linha(
    `\n${cor.vermelho}  Não foi possível montar o site nem após o reparo automático.${cor.fim}`,
  );
  linha(`${cor.fraco}  Detalhes técnicos:${cor.fim}\n`);
  linha(detalhes);
  linha(
    `\n${cor.amarelo}  Feche esta janela e abra o iniciador novamente. Se repetir, envie os detalhes acima.${cor.fim}\n`,
  );
  process.exit(1);
}

if (build.reparado) nota('  Dependências reparadas e site montado com sucesso.');

// ------------------------------------------------------------- túnel e servidor

if (saidaLimpa) console.clear();
else {
  linha(`${cor.fraco}  Abrindo o túnel…${cor.fim}`);
  nota('  Ctrl+C derruba tudo junto.');
}

let servidor = null;
let origemServidor = null;

function criarServidor(origem) {
  // Pelo ambiente, e não só pelo .env: o servidor lê PUBLIC_ORIGIN uma vez, no
  // arranque, e o endereço acabou de nascer.
  const env = { ...process.env };
  if (origem) env.PUBLIC_ORIGIN = origem;

  origemServidor = origem;
  diagnostico.log('server.spawn', { publicOriginChanged: Boolean(origem) });
  const processo = spawn(process.execPath, ['server/index.js'], { cwd: RAIZ, stdio: 'pipe', env });
  servidor = processo;
  acompanhar('servidor', cor.azul, processo, {
    fatal: false,
    semPrefixo: saidaLimpa,
    onClose: (codigo) => {
      // Se ainda é o servidor atual, morreu sem que a supervisão pedisse.
      if (servidor === processo) derrubar(codigo ?? 1);
    },
  });
}

function iniciarServidor(origem) {
  if (!servidor) {
    criarServidor(origem);
    return;
  }

  // Um quick tunnel recebe outro hostname quando o processo inteiro precisa
  // reiniciar. O servidor monta shareUrl e redirect no arranque; mantê-lo com
  // a origem antiga faria os botões abrirem um endereço morto.
  if (origem && origemServidor !== origem) {
    const anterior = servidor;
    servidor = null;
    nota('  O endereço público mudou; atualizando o servidor…');
    anterior.once('close', () => {
      if (!encerrandoAgora()) criarServidor(origem);
    });
    encerrarFilho(anterior);
  }
}

let tunelAtual = null;
let tentativasTunel = 0;
let timerTunel = null;

function agendarTunel(motivo) {
  if (encerrandoAgora() || timerTunel) return;
  const espera = atrasoReinicio(tentativasTunel++);
  diagnostico.log('tunnel.retry', { attempt: tentativasTunel, delayMs: espera, reason: motivo });
  linha(`${cor.amarelo}  ${motivo} Nova tentativa em ${Math.ceil(espera / 1000)}s.${cor.fim}`);
  timerTunel = setTimeout(() => {
    timerTunel = null;
    subirTunel();
  }, espera);
}

async function subirTunel() {
  if (encerrandoAgora()) return;
  try {
    let estabilidade = null;
    const processo = await abrirTunel({
      aoEndereco: (origem) => {
        iniciarServidor(origem);
      },
      // Respeita TUNEL_CONFIG. Sem ele, abrirTunel já escolhe quick tunnel.
      rapido: false,
      gravar: true,
    });
    tunelAtual = processo;
    // Só uma execução realmente estável zera o backoff. Um config inválido
    // pode anunciar o hostname e morrer logo depois; zerar já no anúncio o
    // colocaria num laço de reinício a cada dois segundos.
    estabilidade = setTimeout(() => {
      if (tunelAtual === processo) tentativasTunel = 0;
    }, 60_000);
    estabilidade.unref();
    acompanhar('tunel', cor.amarelo, processo, {
      fatal: false,
      silencioso: saidaLimpa,
      onClose: (codigo) => {
        clearTimeout(estabilidade);
        if (tunelAtual !== processo) return;
        tunelAtual = null;
        agendarTunel(`O Cloudflare encerrou (código ${codigo ?? 'desconhecido'}).`);
      },
    });
  } catch (err) {
    agendarTunel(`Não foi possível abrir o Cloudflare: ${err.message}`);
  }
}

await subirTunel();

setTimeout(() => {
  if (servidor || encerrandoAgora()) return;
  linha(
    `\n${cor.amarelo}  O túnel demorou a responder — subindo o servidor mesmo assim.${cor.fim}`,
  );
  nota('  Em localhost tudo funciona; só o acesso de fora depende do túnel.');
  iniciarServidor(null);
}, 45_000).unref();
