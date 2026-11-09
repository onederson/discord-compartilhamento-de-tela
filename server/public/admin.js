/**
 * Painel administrativo.
 *
 * A tela responde três perguntas, nesta ordem: está funcionando, quem está
 * usando agora, e a máquina aguenta. Tudo que não responde a uma delas ficou
 * de fora — número que só repete outro número não ajuda ninguém a decidir
 * nada.
 */

const $ = (id) => document.getElementById(id);

/** Últimas leituras de banda, para o gráfico. */
const historico = [];
const HISTORICO_MAX = 60;

let timer = null;
let carregando = false;
let ultimo = null;

// ------------------------------------------------------------------ formato

function text(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function formatBytes(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? decimals : 0)} ${units[index]}`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond)) return '—';
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${bits.toFixed(0)} b/s`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : '—';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

/** Plural sem gambiarra de string: "1 sala" e "3 salas". */
function count(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

// -------------------------------------------------------------------- ciclo

/**
 * O ciclo só corre com a aba à vista.
 *
 * Cada volta varre todas as salas, pessoas e transmissões do servidor. Sem
 * pausar, uma aba esquecida aberta de um dia para o outro pede isso mais de
 * quarenta mil vezes sem ninguém olhando.
 */
function startPolling() {
  if (timer) return;
  timer = setInterval(loadMetrics, 2000);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

function setLive(ok, mensagem) {
  const live = $('live');
  live.className = ok ? 'badge on' : 'badge';
  live.replaceChildren(document.createElement('i'), document.createTextNode(` ${mensagem}`));
}

async function loadMetrics() {
  if (carregando) return;
  carregando = true;
  try {
    const response = await fetch('/api/admin/metrics', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    // A sessão dura 8 horas. Quando vence no meio do uso, recarregar devolve
    // a tela de entrada em vez de deixar o painel piscando erro.
    if (response.status === 401) {
      stopPolling();
      location.reload();
      return;
    }

    if (!response.ok) throw new Error(`servidor respondeu ${response.status}`);

    render(await response.json());
    setLive(true, 'Ao vivo');
    $('errorBanner').hidden = true;
  } catch (error) {
    setLive(false, 'Sem conexão');
    $('errorBanner').textContent = `Não foi possível atualizar: ${error.message}`;
    $('errorBanner').hidden = false;
  } finally {
    carregando = false;
  }
}

// ------------------------------------------------------------------ desenho

function render(data) {
  ultimo = data;
  const { summary, traffic } = data;

  text('statPeople', String(summary.users));
  text(
    'statPeopleSub',
    summary.rooms ? count(summary.rooms, 'sala', 'salas') : 'nenhuma sala aberta',
  );

  text('statStreams', String(summary.streams));
  text('statStreamsSub', count(summary.activeWatchers, 'assistindo', 'assistindo'));

  text(
    'statBandwidth',
    formatRate(traffic.receivedBytesPerSecond + traffic.transmittedBytesPerSecond),
  );
  text(
    'statBandwidthSub',
    `↓ ${formatRate(traffic.receivedBytesPerSecond)} · ↑ ${formatRate(traffic.transmittedBytesPerSecond)}`,
  );

  // Quadro que o servidor deixou de mandar porque a fila daquele espectador
  // estourou. É o único sinal na tela de que alguém não está aguentando
  // receber — sem ele, imagem travando não tem onde ser diagnosticada.
  const descartado = traffic.droppedBytesPerSecond;
  $('statDropped').hidden = !(descartado > 0);
  if (descartado > 0) text('statDropped', `${formatRate(descartado)} descartado`);

  text('statPing', formatMs(summary.pingAverageMs));
  text(
    'statPingSub',
    Number.isFinite(summary.pingP95Ms) ? `p95 ${formatMs(summary.pingP95Ms)}` : ' ',
  );

  renderPeople(data);
  renderRecursos(data.system);
  renderAmbiente(data);

  historico.push({
    inbound: traffic.receivedBytesPerSecond,
    outbound: traffic.transmittedBytesPerSecond,
  });
  if (historico.length > HISTORICO_MAX) historico.shift();
  drawChart();
}

// ------------------------------------------------------------------ pessoas

function renderPeople(data) {
  const nomesDeGuild = new Map(data.guilds.map((guild) => [guild.id, guild.name || guild.id]));
  const nomesDeSala = new Map(data.rooms.map((room) => [room.id, room.name]));
  const pessoas = data.users;

  text('peopleCount', String(pessoas.length));
  $('peopleEmpty').hidden = pessoas.length > 0;
  $('peopleScroll').hidden = pessoas.length === 0;

  const linhas = pessoas.map((pessoa) => {
    const linha = document.createElement('tr');

    // textContent em tudo: nome de usuário e de servidor vêm do Discord, ou
    // seja, são texto que outra pessoa escolhe. Montar isso com innerHTML
    // seria entregar o painel a quem trocar o apelido por uma tag <script>.
    celula(linha, pessoa.name, pessoa.id);
    celula(linha, pessoa.guilds.map((id) => nomesDeGuild.get(id) ?? id).join(', ') || '—');
    celula(linha, pessoa.rooms.map((id) => nomesDeSala.get(id) ?? id).join(', ') || '—');

    const estado = document.createElement('td');
    if (pessoa.broadcasting) {
      const selo = document.createElement('span');
      selo.className = 'badge on';
      selo.append(document.createElement('i'), document.createTextNode(' transmitindo'));
      estado.append(selo);
    } else {
      estado.textContent = '—';
      estado.className = 'muted';
    }
    linha.append(estado);

    const ping = document.createElement('td');
    ping.className = 'num';
    ping.textContent = formatMs(pessoa.pingMs);
    linha.append(ping);

    return linha;
  });

  $('peopleRows').replaceChildren(...linhas);
}

/** Uma célula com uma linha principal e, quando útil, uma segunda apagada. */
function celula(linha, principal, secundaria = null) {
  const td = document.createElement('td');
  const caixa = document.createElement('div');
  caixa.className = 'cell';

  const primeira = document.createElement('span');
  primeira.textContent = principal;
  caixa.append(primeira);

  if (secundaria) {
    const segunda = document.createElement('span');
    segunda.className = 'second';
    segunda.textContent = secundaria;
    caixa.append(segunda);
  }

  td.append(caixa);
  linha.append(td);
  return td;
}

// ------------------------------------------------------- recursos e ambiente

function renderRecursos(system) {
  const memoriaUsada = system.memory.hostTotalBytes - system.memory.hostFreeBytes;
  const disco = system.disk;

  // Processo e máquina lado a lado de propósito: é o que separa "a aplicação
  // está pesada" de "tem outra coisa comendo esta máquina".
  text('cpuProcess', formatPercent(system.cpu.processPercent));
  text('cpuHost', formatPercent(system.cpu.hostPercent));
  text('memProcess', formatBytes(system.memory.process.rss));
  text('memHost', `${formatBytes(memoriaUsada)} / ${formatBytes(system.memory.hostTotalBytes)}`);
  text('disk', disco ? `${formatBytes(disco.usedBytes)} / ${formatBytes(disco.totalBytes)}` : '—');
  text('uptime', formatDuration(system.processUptimeSeconds));
}

function renderAmbiente(data) {
  const { configuration: config, system } = data;
  const container = system.container;

  const linhas = [
    ['Ambiente', config.environment],
    ['Origem pública', config.publicOrigin],
    ['Porta', String(config.port)],
    ['Client ID', config.clientId ?? 'não configurado'],
    ['Bot do Discord', config.botConfigured ? 'configurado' : 'não configurado'],
    ['Sistema', `${system.platform} ${system.release}`],
    ['Node', system.nodeVersion],
    ['Máquina', system.hostname],
    ['Núcleos', `${system.cpu.logicalCores} · ${system.cpu.model}`],
    ['Carga média', system.cpu.loadAverage.map((v) => v.toFixed(2)).join(' · ')],
  ];

  // Limites de container só aparecem quando existem: numa máquina comum eles
  // seriam duas linhas dizendo "sem limite", que não é informação.
  if (Number.isFinite(container?.cpuLimitCores)) {
    linhas.push(['Limite de CPU', `${container.cpuLimitCores} núcleos`]);
  }
  if (Number.isFinite(container?.memoryMax)) {
    linhas.push(['Limite de memória', formatBytes(container.memoryMax)]);
  }

  $('envList').replaceChildren(
    ...linhas.map(([rotulo, valor]) => {
      const par = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = rotulo;
      // textContent: origem pública e nome da máquina são texto de fora.
      dd.textContent = valor;
      dd.title = valor;
      par.append(dt, dd);
      return par;
    }),
  );
}

// ------------------------------------------------------------------ gráfico

function drawChart() {
  const canvas = $('chart');
  const box = canvas.getBoundingClientRect();
  if (!box.width) return;

  // Redimensionar o canvas zera a transformação, então a escala vem depois.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);

  const style = getComputedStyle(document.documentElement);
  const cor = (nome) => style.getPropertyValue(nome).trim();

  const pad = { left: 52, right: 4, top: 8, bottom: 18 };
  const larguraPlot = box.width - pad.left - pad.right;
  const alturaPlot = box.height - pad.top - pad.bottom;

  // Piso de 128 KB/s para o gráfico não virar ruído amplificado quando não há
  // ninguém transmitindo.
  const teto = Math.max(128 * 1024, ...historico.flatMap((p) => [p.inbound, p.outbound])) * 1.15;

  ctx.clearRect(0, 0, box.width, box.height);
  ctx.strokeStyle = cor('--border');
  ctx.fillStyle = cor('--dim');
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (alturaPlot * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(box.width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatRate(teto * (1 - i / 4)), pad.left - 8, y + 3);
  }

  for (const [chave, nome] of [
    ['inbound', '--brand'],
    ['outbound', '--ok'],
  ]) {
    ctx.beginPath();
    ctx.strokeStyle = cor(nome);
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';

    historico.forEach((ponto, index) => {
      const valor = ponto[chave];
      if (!Number.isFinite(valor)) return;
      const x = pad.left + (index / Math.max(1, HISTORICO_MAX - 1)) * larguraPlot;
      const y = pad.top + alturaPlot - (valor / teto) * alturaPlot;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.fillText('−2 min', pad.left, box.height - 4);
  ctx.textAlign = 'right';
  ctx.fillText('agora', box.width - pad.right, box.height - 4);
}

// ------------------------------------------------------------------- relatos

/**
 * Relatos de problema e denúncias, mais a moderação que sai deles.
 *
 * Tudo aqui vem de texto escrito por outra pessoa (o relato, o nome de quem
 * transmitia), então só entra na página por textContent. Os prints chegam por
 * <img src>, nunca embutidos em HTML.
 */

const CATEGORIAS = {
  sexual: 'Conteúdo sexual',
  violencia: 'Violência',
  odio: 'Discurso de ódio',
  menores: 'Risco a menores',
  ilegal: 'Atividade ilegal',
  golpe: 'Golpe ou fraude',
  pirataria: 'Pirataria',
  dados: 'Dados pessoais expostos',
  outro: 'Outro',
};

const ID_RELATO = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
const RELATOS_A_CADA_MS = 15_000;

// Abertos por padrão: é a fila de trabalho, e o que já foi resolvido só importa
// quando alguém procura de propósito.
const filtros = { tipo: null, status: 'aberto' };
let relatosTimer = null;
let relatoAberto = null;

function el(tag, classe, texto) {
  const node = document.createElement(tag);
  if (classe) node.className = classe;
  if (texto != null) node.textContent = texto;
  return node;
}

function formatData(iso) {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '—' : data.toLocaleString('pt-BR');
}

/** Pedido ao servidor. 401 devolve à tela de entrada; outro erro vira exceção com a mensagem. */
async function api(caminho, corpo = null) {
  const response = await fetch(caminho, {
    cache: 'no-store',
    ...(corpo
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        }
      : {}),
  });
  if (response.status === 401) {
    location.reload();
    throw new Error('sessão expirada');
  }
  const dados = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(dados.error || `servidor respondeu ${response.status}`);
  return dados;
}

function seloStatus(relato) {
  return relato.status === 'aberto'
    ? el('span', 'badge warn', 'aberto')
    : el('span', 'badge on', 'resolvido');
}

async function carregarRelatos() {
  try {
    const consulta = new URLSearchParams();
    if (filtros.tipo) consulta.set('tipo', filtros.tipo);
    if (filtros.status) consulta.set('status', filtros.status);
    const [{ relatos }, { bloqueios }] = await Promise.all([
      api(`/api/admin/relatos?${consulta}`),
      api('/api/admin/moderacao/bloqueios'),
    ]);
    renderRelatos(relatos);
    renderBloqueios(bloqueios);
  } catch {
    // A lista é secundária ao resto do painel; o aviso de conexão perdida já
    // cobre a queda do servidor, então uma falha aqui não pede aviso próprio.
  }
}

function renderRelatos(relatos) {
  text('relatosCount', String(relatos.length));
  $('relatosEmpty').hidden = relatos.length > 0;
  $('relatosScroll').hidden = relatos.length === 0;

  const linhas = relatos.map((relato) => {
    const linha = document.createElement('tr');
    if (relato.urgente) linha.classList.add('urgente');
    if (relato.id === relatoAberto) linha.classList.add('ativa');
    linha.tabIndex = 0;
    linha.addEventListener('click', () => abrirRelato(relato.id));
    linha.addEventListener('keydown', (evento) => {
      if (evento.key === 'Enter' || evento.key === ' ') {
        evento.preventDefault();
        abrirRelato(relato.id);
      }
    });

    celula(linha, formatData(relato.criadoEm));

    const tipo = document.createElement('td');
    tipo.textContent = relato.tipo === 'denuncia' ? 'Denúncia' : 'Bug';
    if (relato.urgente) tipo.append(' ', el('span', 'badge urgente-selo', 'URGENTE'));
    linha.append(tipo);

    celula(linha, relato.categoria ? (CATEGORIAS[relato.categoria] ?? relato.categoria) : '—');

    const previa = el('td', 'previa', relato.previa || '—');
    previa.title = relato.previa;
    linha.append(previa);

    const status = document.createElement('td');
    status.append(seloStatus(relato));
    linha.append(status);
    return linha;
  });
  $('relatosRows').replaceChildren(...linhas);
}

function renderBloqueios(bloqueios) {
  text('bloqueiosCount', String(bloqueios.length));
  $('bloqueiosEmpty').hidden = bloqueios.length > 0;
  $('bloqueiosScroll').hidden = bloqueios.length === 0;

  const linhas = bloqueios.map((b) => {
    const linha = document.createElement('tr');
    celula(linha, b.nome || b.uid, b.uid);
    celula(linha, b.motivo || '—');
    celula(linha, b.por || '—', formatData(b.em));

    const acao = document.createElement('td');
    const botao = el('button', 'btn', 'Desbloquear');
    botao.type = 'button';
    botao.addEventListener('click', async () => {
      botao.disabled = true;
      try {
        await api('/api/admin/moderacao/desbloquear', { uid: b.uid });
      } catch (erro) {
        alert(`Não foi possível desbloquear: ${erro.message}`);
      }
      carregarRelatos();
    });
    acao.append(botao);
    linha.append(acao);
    return linha;
  });
  $('bloqueiosRows').replaceChildren(...linhas);
}

// ------------------------------------------------------------------ detalhe

function linhaDl(rotulo, valor) {
  const par = document.createElement('div');
  par.append(el('dt', null, rotulo), el('dd', null, valor || '—'));
  return par;
}

function eventoLinha(evento) {
  const item = el('li');
  const hora = new Date(evento.at);
  item.append(
    el('time', null, Number.isNaN(hora.getTime()) ? '—' : hora.toLocaleTimeString('pt-BR')),
    el('code', null, evento.event),
  );
  const dados = Object.entries(evento.data ?? {})
    .map(
      ([chave, valor]) => `${chave}=${typeof valor === 'object' ? JSON.stringify(valor) : valor}`,
    )
    .join(' ');
  if (dados) item.append(el('span', 'muted', dados));
  return item;
}

function avisoDetalhe(mensagem, erro = false) {
  const aviso = $('relatoAviso');
  if (!aviso) return;
  aviso.textContent = mensagem;
  aviso.className = erro ? 'banner' : 'aviso-ok';
  aviso.hidden = false;
}

function botaoAcao(rotulo, classe, aoClicar) {
  const botao = el('button', `btn ${classe}`.trim(), rotulo);
  botao.type = 'button';
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    try {
      await aoClicar();
    } catch (erro) {
      avisoDetalhe(`Não deu certo: ${erro.message}`, true);
    } finally {
      botao.disabled = false;
    }
  });
  return botao;
}

async function abrirRelato(id) {
  if (!ID_RELATO.test(id)) return;
  const caixa = $('relatoDetalhe');
  try {
    const relato = await api(`/api/admin/relatos/${id}`);
    relatoAberto = id;
    caixa.replaceChildren(montarDetalhe(relato));
    caixa.hidden = false;
    caixa.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    carregarRelatos();
  } catch (erro) {
    relatoAberto = null;
    caixa.replaceChildren(el('p', 'banner', `Não foi possível abrir o relato: ${erro.message}`));
    caixa.hidden = false;
  }
}

function montarDetalhe(relato) {
  const raiz = el('article', relato.urgente ? 'relato urgente' : 'relato');
  raiz.id = `relato-${relato.id}`;

  const cabeca = el('div', 'panel-head');
  const titulo =
    relato.tipo === 'denuncia'
      ? `Denúncia: ${CATEGORIAS[relato.categoria] ?? relato.categoria}`
      : 'Problema relatado';
  cabeca.append(el('h3', null, titulo));
  if (relato.urgente) cabeca.append(el('span', 'badge urgente-selo', 'URGENTE'));
  cabeca.append(el('div', 'spacer'), seloStatus(relato));
  const fechar = el('button', 'btn', 'Fechar');
  fechar.type = 'button';
  fechar.addEventListener('click', () => {
    relatoAberto = null;
    $('relatoDetalhe').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    carregarRelatos();
  });
  cabeca.append(fechar);
  raiz.append(cabeca);

  if (relato.urgente) {
    raiz.append(
      el(
        'p',
        'banner',
        'Nenhuma imagem foi guardada. Encerre ou bloqueie por aqui e denuncie ao Discord e à SaferNet.',
      ),
    );
  }

  raiz.append(el('p', 'relato-texto', relato.texto || '(sem texto)'));

  const dl = el('dl', 'dl dl-largo');
  dl.append(
    linhaDl('Data', formatData(relato.criadoEm)),
    linhaDl('Origem', relato.origem),
    linhaDl('Sala', relato.sala ? `${relato.sala.nome ?? '—'} (${relato.sala.id})` : '—'),
    linhaDl('Quem relatou', relato.quem ? `${relato.quem.nome} (${relato.quem.uid})` : '—'),
  );
  if (relato.alvo) {
    dl.append(
      linhaDl('Quem transmitia', `${relato.alvo.nome} (${relato.alvo.uid})`),
      linhaDl('Fonte', relato.alvo.fonte),
      linhaDl(
        'Transmitindo há',
        Number.isFinite(relato.alvo.transmitindoHaS)
          ? formatDuration(relato.alvo.transmitindoHaS)
          : '—',
      ),
    );
  }
  if (relato.resolucao) {
    dl.append(
      linhaDl('Resolvido', `${formatData(relato.resolucao.em)} por ${relato.resolucao.por}`),
      linhaDl('Nota', relato.resolucao.nota),
    );
  }
  raiz.append(dl);

  if (relato.prints > 0) {
    const galeria = el('div', 'prints');
    for (let n = 1; n <= relato.prints; n++) {
      const link = document.createElement('a');
      link.href = `/api/admin/relatos/${relato.id}/print/${n}`;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.src = link.href;
      img.alt = `Print ${n} da transmissão`;
      img.loading = 'lazy';
      link.append(img);
      galeria.append(link);
    }
    raiz.append(galeria);
  }

  const eventos = relato.servidor?.eventos ?? [];
  if (eventos.length) {
    const lista = el('ol', 'linha-do-tempo');
    lista.append(...eventos.map(eventoLinha));
    const detalhes = el('details');
    detalhes.open = true;
    detalhes.append(el('summary', null, `Linha do tempo do servidor (${eventos.length})`), lista);
    raiz.append(detalhes);
  }

  const contexto = {};
  if (relato.contexto) contexto.contexto = relato.contexto;
  if (relato.servidor?.sala) contexto.salaNoMomento = relato.servidor.sala;
  if (Object.keys(contexto).length) {
    const detalhes = el('details');
    detalhes.append(
      el('summary', null, 'Contexto'),
      el('pre', 'json', JSON.stringify(contexto, null, 2)),
    );
    raiz.append(detalhes);
  }

  const aviso = el('p', 'aviso-ok');
  aviso.id = 'relatoAviso';
  aviso.hidden = true;
  raiz.append(aviso);

  const acoes = el('div', 'acoes');
  if (relato.alvo?.uid) {
    acoes.append(
      botaoAcao('Encerrar transmissão', 'btn-perigo', async () => {
        if (!confirm(`Encerrar as transmissões de ${relato.alvo.nome}?`)) return;
        const { encerradas } = await api('/api/admin/moderacao/encerrar', { uid: relato.alvo.uid });
        avisoDetalhe(`${count(encerradas, 'transmissão encerrada', 'transmissões encerradas')}.`);
      }),
      botaoAcao('Bloquear', 'btn-perigo', async () => {
        const motivo = prompt(`Motivo do bloqueio de ${relato.alvo.nome}:`, relato.categoria ?? '');
        if (motivo === null) return;
        const { encerradas } = await api('/api/admin/moderacao/bloquear', {
          uid: relato.alvo.uid,
          nome: relato.alvo.nome,
          motivo,
        });
        const paradas = count(encerradas, 'transmissão encerrada', 'transmissões encerradas');
        avisoDetalhe(`${relato.alvo.nome} foi bloqueado (${paradas}).`);
        carregarRelatos();
      }),
    );
  }
  if (relato.status === 'aberto') {
    acoes.append(
      botaoAcao('Marcar resolvido', 'btn-brand-suave', async () => {
        const nota = prompt('Nota sobre a resolução (opcional):', '');
        if (nota === null) return;
        await api(`/api/admin/relatos/${relato.id}/resolver`, { nota });
        await abrirRelato(relato.id);
      }),
    );
  }
  raiz.append(acoes);
  return raiz;
}

function aplicarFiltros() {
  for (const botao of document.querySelectorAll('.chip')) {
    const ativo = filtros[botao.dataset.filtro] === botao.dataset.valor;
    botao.classList.toggle('ativo', ativo);
    botao.setAttribute('aria-pressed', String(ativo));
  }
}

for (const botao of document.querySelectorAll('.chip')) {
  botao.addEventListener('click', () => {
    const { filtro, valor } = botao.dataset;
    // Clicar de novo no filtro ativo tira o filtro.
    filtros[filtro] = filtros[filtro] === valor ? null : valor;
    aplicarFiltros();
    carregarRelatos();
  });
}

/** Abre o relato do endereço (#relato-<id>), que é o link do aviso no Discord. */
function abrirDoEndereco() {
  const achado = /^#relato-(.+)$/.exec(location.hash);
  if (achado && ID_RELATO.test(achado[1])) abrirRelato(achado[1]);
}

window.addEventListener('hashchange', abrirDoEndereco);

function startRelatos() {
  aplicarFiltros();
  carregarRelatos();
  if (!relatosTimer) relatosTimer = setInterval(carregarRelatos, RELATOS_A_CADA_MS);
}

function stopRelatos() {
  clearInterval(relatosTimer);
  relatosTimer = null;
}

// --------------------------------------------------------------------- boot

async function boot() {
  try {
    const response = await fetch('/api/admin/me', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      $('loading').hidden = true;
      $('login').hidden = false;
      if (body.configured === false) {
        text(
          'loginMessage',
          'O painel está desligado. Defina DISCORD_ADMIN_ID no arquivo .env e reinicie.',
        );
        $('loginButton').hidden = true;
      }
      return;
    }

    text('adminName', body.user.name);
    if (body.user.avatar) {
      const img = $('adminAvatar');
      img.src = `/api/avatar/${body.user.id}/${body.user.avatar}`;
      img.hidden = false;
    }

    $('loading').hidden = true;
    $('dashboard').hidden = false;
    await loadMetrics();
    startPolling();
    startRelatos();
    abrirDoEndereco();
  } catch {
    $('loading').hidden = true;
    $('login').hidden = false;
    text('loginMessage', 'O servidor não respondeu. Tente de novo em alguns segundos.');
  }
}

$('refresh').addEventListener('click', loadMetrics);

$('logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => null);
  location.reload();
});

window.addEventListener('resize', () => ultimo && drawChart());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    stopRelatos();
    return;
  }
  loadMetrics();
  startPolling();
  startRelatos();
});

boot();
