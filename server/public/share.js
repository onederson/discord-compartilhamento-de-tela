/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Uma página, duas fontes. Tela e câmera são painéis independentes, cada um com
 * sua própria conexão e seu próprio ligar/desligar — abrir uma aba por fonte
 * dobraria as janelas que a pessoa precisa manter vivas, e nenhuma delas pode
 * ser fechada enquanto transmite.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import {
  createBroadcaster,
  supportError,
  fonteIndisponivel,
  opcoesTela,
  pedirDisplayMedia,
} from '/shared/broadcaster.js?v=16';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

const nativeAudioConfig = fetch('/api/config', { cache: 'no-store' })
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);

async function nativeAudioProof() {
  const config = await nativeAudioConfig;
  if (!config?.nativeAudioLocalUrl) {
    throw new Error(
      'O capturador local não está disponível. No Firefox, ele funciona somente no PC Windows que está executando o INICIAR.',
    );
  }

  let response;
  try {
    response = await fetch(`${config.nativeAudioLocalUrl}/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new Error(
      'Este navegador não encontrou o capturador neste computador. Se você entrou remotamente, use Chrome, Edge, Brave ou Opera e marque o áudio no seletor.',
    );
  }

  if (!response.ok)
    throw new Error('O capturador local recusou esta transmissão. Reabra a página.');
  const { proof } = await response.json();
  if (!proof) throw new Error('O capturador local não devolveu uma autorização válida.');
  return proof;
}

const FONTES = ['tela', 'camera'];
const TITULO = document.title;

/**
 * As opções da transmissão, decididas na engrenagem da atividade.
 *
 * Chegam pela URL quando esta aba é aberta e podem ser trocadas depois, pelo
 * `start-request` — a aba costuma estar aberta desde antes da última mexida.
 * Não há controle aqui: dois lugares para a mesma escolha significam um deles
 * desatualizado, e o que fica velho é sempre o que não foi usado por último.
 */
const opcoes = {
  bitrate: Number(query.get('q')) || 2_500_000,
  fps: Number(query.get('fps')) || 30,
};

function mostrarQualidade() {
  const taxa = (opcoes.bitrate / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  $('quality-summary').textContent = `${opcoes.fps} fps · ${taxa} Mb/s`;
}

function mostrarControle(texto, estado) {
  $('control-status').textContent = texto;
  $('control-status').dataset.state = estado;
}

function aplicarOpcoes(novas) {
  if (!novas) return;
  if (Number(novas.q)) opcoes.bitrate = Number(novas.q);
  if (Number(novas.fps)) opcoes.fps = Number(novas.fps);
  mostrarQualidade();
}
mostrarQualidade();

const paineis = {};
// Memória curta para o relato de problema: últimos avisos e últimas métricas.
const AVISOS_GUARDADOS = 30;
const avisosRecentes = []; // { fonte, msg, t }
const ultimosStats = {}; // fonte -> últimas métricas, sem a lista de espectadores
window.name = 'discord-screen-captura';

function atualizarStatusGlobal() {
  const estaAoVivo = FONTES.some((f) => paineis[f]?.ativo());
  const pill = $('header-status-pill');
  const text = $('header-status-text');
  if (!pill || !text) return;

  if (estaAoVivo) {
    pill.className = 'status-pill status-live-pill';
    text.textContent = 'Ao Vivo';
  } else {
    pill.className = 'status-pill status-offline-pill';
    text.textContent = 'Offline';
  }
}

try {
  const focusBc = new BroadcastChannel('discord-screenshare-focus');
  focusBc.addEventListener('message', (e) => {
    const data = e.data;
    if (!data) return;

    if (data.type === 'fechar-todas') {
      fecharAba();
      return;
    }

    if (data.type === 'substituicao-concluida' || data.type === 'troca-completa') {
      if (query.get('troca') !== '1') {
        try {
          window.close();
        } catch {
          /* a janela pode ter sido aberta pelo usuário ou o fechamento bloqueado pelo navegador */
        }
      }
      return;
    }

    if (data.type === 'trocar-tela' || (data.type === 'focar' && data.acao === 'trocar-tela')) {
      window.name = 'discord-screen-captura';
      window.focus();
      chamar('tela');
      const painel = paineis.tela;
      if (painel?.ativo()) {
        painel.trocarTela();
      }
      return;
    }

    if (data.fonte === 'camera' || (data.type === 'focar' && data.fonte === 'camera')) {
      window.name = 'discord-screen-captura';
      window.focus();
      chamar('camera');
      const painel = paineis.camera;
      if (painel && !painel.ativo() && !painel.indisponivel()) {
        painel.verCamera?.();
        painel.setStatus(
          'Clique no botão "Ligar a câmera" acima para transmitir a webcam.',
          'aviso',
        );
      }
      return;
    }

    if (data.fonte === 'tela' || (data.type === 'focar' && data.fonte === 'tela')) {
      window.name = 'discord-screen-captura';
      window.focus();
      chamar('tela');
      const painel = paineis.tela;
      if (painel && !painel.ativo() && !painel.indisponivel()) {
        painel.ligar?.()?.catch?.(() => {});
      }
      return;
    }

    if (data.type === 'focar') {
      window.name = 'discord-screen-captura';
      window.focus();
    }
  });
} catch {
  // BroadcastChannel pode não estar disponível em ambientes restritos.
}

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  $('sessionOverview').hidden = true;
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  // Título e motivo no mesmo lugar: sem o cabeçalho não há mais onde separar
  // os dois, e separados em duas linhas eles diziam a mesma coisa duas vezes.
  const el = $('pageStatus');
  el.textContent = `${titulo} ${msg}`;
  el.className = 'status error';
}

function fecharAba(motivo) {
  for (const f of FONTES) paineis[f]?.parar();
  if (controle) {
    clearTimeout(religar);
    religar = 'morto';
    try {
      controle.close();
    } catch {
      /* ignora erro ao fechar socket */
    }
    controle = null;
  }
  falhar(
    'Janela encerrada.',
    motivo ||
      'Esta janela foi fechada porque a transmissão foi encerrada ou você saiu da atividade no Discord.',
  );
  try {
    window.open('', '_self');
    window.close();
  } catch {
    /* navegador pode impedir fechar janela via script */
  }
}

// --------------------------------------------------------------- chamamento

let piscando = null;

/**
 * Destaca a fonte que a atividade pediu e chama pelo título.
 *
 * Uma aba em segundo plano não pode se trazer para a frente: `window.focus()` é
 * ignorado, e quem abriu esta página foi o navegador do sistema, não uma página
 * nossa que pudesse chamá-la de volta. O título é o único lugar onde ela ainda
 * aparece para quem está olhando outra coisa.
 */
function chamar(fonte) {
  for (const f of FONTES) $(`bloco-${f}`).classList.toggle('chamando', f === fonte);

  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
  if (!fonte) return;

  // Piscar só serve para quem não está olhando; com a aba à frente, o destaque
  // no bloco já diz qual é.
  if (!document.hidden) return;

  const aviso = fonte === 'camera' ? '● Ligar a câmera' : '● Compartilhar a tela';
  let ligado = false;
  piscando = setInterval(() => {
    ligado = !ligado;
    document.title = ligado ? aviso : TITULO;
  }, 1200);
}

// Aba de captura escondida é o que faz o navegador estrangular timers e
// captura. O diagnóstico vai pela conexão de quem está no ar; sem ninguém no
// ar não há por onde mandar nem o que diagnosticar.
let ocultoDesde = null;
document.addEventListener('visibilitychange', () => {
  const oculta = document.hidden;
  const ocultoMs = !oculta && ocultoDesde !== null ? Date.now() - ocultoDesde : null;
  ocultoDesde = oculta ? (ocultoDesde ?? Date.now()) : null;
  const painel = FONTES.map((f) => paineis[f]).find((p) => p?.ativo());
  painel?.diagnosticar('tx-visibilidade', {
    estado: oculta ? 'hidden' : 'visible',
    ...(ocultoMs === null ? {} : { ocultoMs }),
  });
});

// Visto o recado, para de piscar — o destaque no bloco continua dizendo qual é.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !piscando) return;
  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
});

/**
 * A configuração mudou na engrenagem da atividade.
 *
 * Vale na hora para o que já está no ar. O som não passa por aqui: ele é
 * decidido no seletor do navegador, na hora da captura.
 */
function aplicarConfig(novas) {
  aplicarOpcoes(novas);
  for (const f of FONTES) paineis[f]?.aplicarQualidade();
}

/**
 * A atividade pediu uma fonte.
 *
 * A câmera abre aqui mesmo, mas em prévia: getUserMedia não exige gesto do
 * usuário depois da permissão concedida, então dá para mostrar o que ela vê — e
 * mostrar é o certo, porque ir ao ar com a webcam errada não tem desfazer.
 *
 * Tela não abre nem em prévia: `getDisplayMedia` exige ativação transitória e
 * lança InvalidStateError sem ela, então o seletor só nasce de um clique nesta
 * página. O que resta é chamar e esperar.
 */
function atenderPedido(fonte, novas) {
  aplicarOpcoes(novas);

  const painel = paineis[fonte];
  if (!painel || painel.ativo() || painel.indisponivel()) return;

  chamar(fonte);
  if (fonte === 'camera') {
    painel.verCamera();
  } else if (fonte === 'tela') {
    painel.ligar?.()?.catch?.(() => {});
  }
}

// --------------------------------------------------------------- controle

/**
 * Conexão de controle: aberta ao carregar, viva enquanto esta aba estiver.
 *
 * É por ela que a atividade alcança esta página **antes** de existir qualquer
 * transmissão — para pedir uma fonte, ou para avisar que a configuração mudou.
 * As conexões de transmissão não serviriam: cada uma nasce só depois que a
 * captura foi concedida, então com nada no ar não há ninguém escutando.
 */
let controle = null;
let religar = null;
let avisoAtividade = false;

// O servidor manda {"type":"hb"} a cada 10s. O ping de protocolo é invisível
// ao JS, então só o hb permite perceber um socket meio-aberto (half-open).
const SILENCIO_MAX_MS = 25_000;
const SILENCIO_VERIFICA_MS = 5_000;
let vigiaControle = null;

// Em sala de call a sala é recriada com o MESMO id quando a atividade volta,
// então "sala fechada" ali é uma pausa, não um fim: a aba espera e tenta de novo.
const CALL_RELIGAR_MS = 5_000;
const CALL_JANELA_MS = 10 * 60_000;
let salaFechadaDesde = null; // quando começou a espera pela sala de call

/** Sala de call? O id vai no token: base64url(JSON).assinatura. */
function ehSalaDeCall() {
  const sala = readTokenPayload()?.room;
  return typeof sala === 'string' && sala.startsWith('call-');
}

function desistirDaSala() {
  clearTimeout(religar);
  religar = 'morto';
  salaFechadaDesde = null;
  mostrarControle('Sala encerrada', 'offline');
  $('pageStatus').textContent = 'A sala foi fechada. Volte à atividade e comece de novo.';
  $('pageStatus').className = 'status aviso';
}

function ligarControle() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&modo=controle`,
  );
  controle = socket;
  let ultimoRecebido = Date.now();

  socket.addEventListener('open', () => mostrarControle('Conectado à sala', 'connected'));
  socket.addEventListener('message', (e) => {
    ultimoRecebido = Date.now();
    if (typeof e.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    if (msg.type === 'hb') {
      // Só vigia depois do primeiro hb: servidor antigo nunca manda, e vigiar
      // o silêncio dele derrubaria uma conexão saudável.
      if (!vigiaControle) {
        vigiaControle = setInterval(() => {
          if (controle !== socket) {
            clearInterval(vigiaControle);
            vigiaControle = null;
            return;
          }
          if (Date.now() - ultimoRecebido < SILENCIO_MAX_MS) return;
          // O close de um socket meio-aberto pode levar minutos: segue já
          // para a reconexão, e o guard de aoFecharControle ignora o close real.
          aoFecharControle(socket);
          try {
            socket.close();
          } catch {
            /* já fechado */
          }
        }, SILENCIO_VERIFICA_MS);
      }
      return;
    }

    // Qualquer coisa além do room-gone prova que a sala voltou.
    if (salaFechadaDesde !== null && msg.type !== 'room-gone') {
      salaFechadaDesde = null;
      mostrarControle('Conectado à sala', 'connected');
      $('pageStatus').textContent = '';
      $('pageStatus').className = 'status';
    }

    if (msg.type === 'start-request') {
      window.name = 'discord-screen-captura';
      window.focus();
      atenderPedido(msg.fonte, msg.opcoes);

      if (msg.fonte === 'camera') {
        const painel = paineis.camera;
        if (painel && !painel.ativo() && !painel.indisponivel()) {
          painel.setStatus(
            'Clique no botão "Ligar a câmera" acima para transmitir a webcam.',
            'aviso',
          );
        }
      }

      if (
        msg.fonte === 'camera' &&
        'Notification' in window &&
        Notification.permission === 'granted' &&
        document.hidden
      ) {
        try {
          const notif = new Notification('Ligar câmera no Discord', {
            body: 'Clique aqui para abrir a câmera na transmissão.',
            tag: 'discord-ligar-camera',
          });
          notif.onclick = () => {
            window.focus();
            notif.close();
            paineis.camera?.verCamera();
          };
        } catch {
          /* notificações podem estar bloqueadas */
        }
      }
    } else if (msg.type === 'config-request') aplicarConfig(msg.opcoes);
    else if (msg.type === 'change-screen-request') {
      window.name = 'discord-screen-captura';
      window.focus();
      chamar('tela');
      const painel = paineis.tela;
      if (painel?.ativo()) {
        painel.trocarTela();
      }

      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try {
          const notif = new Notification('Trocar de tela no Discord', {
            body: 'Clique aqui para escolher a nova janela ou tela.',
            tag: 'discord-trocar-tela',
          });
          notif.onclick = () => {
            window.focus();
            notif.close();
            painel?.trocarTela();
          };
        } catch {
          // Notificação do sistema indisponível ou bloqueada pelo SO.
        }
      }
    } else if (msg.type === 'atividade-fechada') {
      // O Discord fechou a atividade (há máquinas em que basta focar um jogo),
      // mas a tela segue no ar para quem assiste. Sem este aviso, a pessoa não
      // teria onde ver que continua transmitindo.
      mostrarControle('Atividade fechada — você continua ao vivo', 'reconnecting');
      $('pageStatus').textContent =
        'O Discord fechou a atividade, mas a transmissão continua para quem está na sala. Reabra a atividade para voltar a assistir, ou pare a transmissão aqui.';
      $('pageStatus').className = 'status aviso';
      avisoAtividade = true;
    } else if (msg.type === 'atividade-voltou') {
      mostrarControle('Conectado à sala', 'connected');
      if (avisoAtividade) {
        $('pageStatus').textContent = '';
        $('pageStatus').className = 'status';
        avisoAtividade = false;
      }
    } else if (msg.type === 'close-request') {
      fecharAba(msg.motivo);
    } else if (msg.type === 'room-gone') {
      if (ehSalaDeCall()) {
        salaFechadaDesde ??= Date.now();
        if (Date.now() - salaFechadaDesde < CALL_JANELA_MS) {
          mostrarControle('Sala fechada — aguardando a atividade', 'reconnecting');
          $('pageStatus').textContent =
            'A sala da call fechou. Esta aba tenta voltar sozinha quando a atividade reabrir.';
          $('pageStatus').className = 'status aviso';
          clearTimeout(religar);
          religar = setTimeout(ligarControle, CALL_RELIGAR_MS);
          return;
        }
      }
      // Sala fechada: não há a quem transmitir, e insistir na reconexão só
      // gastaria rede contra um id que não existe mais.
      desistirDaSala();
    }
  });

  // Sem reconectar, uma queda de rede deixa a aba aberta e surda, sem nada na
  // tela dizendo que ela parou de obedecer à atividade.
  socket.addEventListener('close', () => aoFecharControle(socket));
}

function aoFecharControle(socket) {
  if (controle !== socket) return;
  clearInterval(vigiaControle);
  vigiaControle = null;
  controle = null;
  if (religar === 'morto') return;
  if (salaFechadaDesde !== null) {
    // O servidor costuma fechar o socket logo após o room-gone: a espera de
    // call precisa continuar no ritmo dela, e acabar no prazo.
    if (Date.now() - salaFechadaDesde >= CALL_JANELA_MS) {
      desistirDaSala();
      return;
    }
    clearTimeout(religar);
    religar = setTimeout(ligarControle, CALL_RELIGAR_MS);
    return;
  }
  mostrarControle('Reconectando à sala', 'reconnecting');
  clearTimeout(religar);
  religar = setTimeout(ligarControle, 3000);
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;
  let ligando = false;
  let watchersSignature = null;

  /**
   * Prévia local: o que a fonte mostra, antes de qualquer transmissão.
   *
   * Existe porque ir ao ar com a fonte errada não tem desfazer — quem está
   * assistindo já viu a janela que não era para ver, ou a webcam que não era
   * para ligar. Conferir e transmitir passam a ser dois gestos.
   *
   * O stream da prévia é reaproveitado pela transmissão, e é por isso que ela
   * pede a tela com as mesmas opções: com outras, ligar o som depois exigiria
   * escolher a tela de novo.
   */
  let previa = null;
  // Qual câmera. `null` é o que o navegador escolher.
  let dispositivo = null;

  function pararPrevia() {
    previa?.getTracks().forEach((t) => t.stop());
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;
  }

  function mostrarPrevia(stream) {
    previa = stream;
    el('previa').srcObject = stream;
    el('previa')
      .play()
      .catch(() => {});
    el('previa').hidden = false;
    el('vazio').hidden = true;

    // A fonte pode acabar sozinha — webcam desconectada, janela fechada. Sem
    // isto o último quadro fica congelado e a prévia passa a mentir.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (previa === stream) {
        pararPrevia();
        setStatus(camera ? 'Prévia da câmera fechada.' : 'Prévia da tela fechada.');
      }
    });
  }

  function setStatus(msg, kind = '') {
    const alvo = el('status');
    alvo.textContent = msg;
    alvo.className = `status ${kind}`;
  }

  function mostrarSetup() {
    el('preview').srcObject = null;
    el('live').hidden = true;
    el('setup').hidden = false;
    el('start').disabled = false;
  }

  // ------------------------------------------------------ escolher a fonte

  /** Abre a prévia da câmera, trocando a que estiver aberta. */
  async function verCamera(id = dispositivo) {
    setStatus('Abrindo a câmera…');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: id ? { deviceId: { exact: id } } : true,
        audio: false,
      });
      // Sem escolha explícita, adota a que o navegador deu: assim o tique do
      // menu marca a que está no ar em vez de não marcar nenhuma.
      dispositivo = id ?? s.getVideoTracks()[0]?.getSettings().deviceId ?? null;
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia ativa — clique no botão "Ligar a câmera" acima para transmitir.');
      await listarCameras();
    } catch (err) {
      setStatus(
        err.name === 'NotAllowedError'
          ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
          : err.message,
        'error',
      );
    }
  }

  /** Abre a prévia da tela. O seletor exige o clique, que é quem chama isto. */
  async function verTela() {
    try {
      const s = await pedirDisplayMedia(opcoesTela({ fps: opcoes.fps, comSom: true }), {
        comSom: true,
      });
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia ativa — clique no botão "Escolher janela ou tela" acima para transmitir.');
    } catch (err) {
      // Cancelar o seletor é escolha, não falha.
      if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
    }
  }

  function fecharMenu() {
    el('menu').hidden = true;
    el('escolher').setAttribute('aria-expanded', 'false');
  }

  /**
   * A lista de câmeras.
   *
   * Os nomes só chegam depois da permissão — antes dela o navegador entrega os
   * dispositivos anônimos, para não revelar o hardware a quem não pediu nada.
   * Por isso abrir o menu abre a prévia primeiro.
   */
  async function listarCameras() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput',
    );

    el('menu').replaceChildren(
      ...cams.map((d, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(d.deviceId === dispositivo));
        b.textContent = d.label || `Câmera ${i + 1}`;
        b.addEventListener('click', () => {
          fecharMenu();
          verCamera(d.deviceId);
        });
        li.append(b);
        return li;
      }),
    );
  }

  /**
   * Abre o menu de câmeras.
   *
   * Lista sem pedir a câmera: `enumerateDevices` responde sem permissão — só
   * devolve os nomes em branco, e uma lista de "Câmera 1, Câmera 2" já deixa
   * escolher. Exigir a permissão antes acorrentava o menu ao sucesso do
   * `getUserMedia`: bastava a câmera estar ocupada por outro programa para a
   * seta parar de responder, sem nada explicando por quê.
   *
   * Os nomes de verdade chegam depois da primeira prévia, e a próxima abertura
   * do menu já os mostra.
   */
  async function escolher() {
    if (!camera) return verTela();

    if (!el('menu').hidden) return fecharMenu();

    await listarCameras();

    if (!el('menu').childElementCount) {
      setStatus('Nenhuma câmera encontrada neste computador.', 'error');
      return;
    }

    el('menu').hidden = false;
    el('escolher').setAttribute('aria-expanded', 'true');
  }

  // ------------------------------------------------------------- transmitir

  async function ligar() {
    // Pedido repetido não reabre nada: a segunda conexão seria recusada pelo
    // servidor, e o seletor de tela abriria por cima do que já está no ar.
    if (broadcaster || ligando) return;
    ligando = true;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const isTroca = query.get('troca') === '1';
    const wsUrl = `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}${isTroca ? '&substituir=1' : ''}`;

    broadcaster = createBroadcaster({
      wsUrl,
      bitrate: opcoes.bitrate,
      fps: opcoes.fps,
      audio: !camera,
      fonte,
      // A prévia já pagou o gesto do usuário e a permissão: reaproveitá-la é o
      // que evita o seletor de tela abrir uma segunda vez para o mesmo
      // compartilhamento.
      streamPronto: previa,
      deviceId: camera ? dispositivo : null,
      onStatus: (s) => {
        const origem = s.captureFps ? ` · fonte ${Math.round(s.captureFps)} fps` : '';
        setStatus(
          `Codec: ${s.codec} · ${s.width}×${s.height}${origem} · captura ${s.direct ? 'direta' : 'via <video>'}`,
        );
      },
      onStats: (s) => {
        ultimosStats[fonte] = { ...s, watchers: undefined };
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('fps').title =
          `Quadros recebidos da fonte: ${s.captureFps} · enviados: ${s.fps} · descartados: ${s.droppedFrames}`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;

        const box = $(`${fonte}-watchers-box`);
        const list = $(`${fonte}-watchers-list`);
        const signature = JSON.stringify(s.watchers ?? []);
        if (box && list && signature !== watchersSignature) {
          watchersSignature = signature;
          if (Array.isArray(s.watchers) && s.watchers.length > 0) {
            box.hidden = false;
            list.replaceChildren(
              ...s.watchers.map((w) => {
                const chip = document.createElement('div');
                chip.className = 'watcher-chip';

                if (w.avatar) {
                  const img = document.createElement('img');
                  img.className = 'watcher-avatar';
                  img.src = `/api/avatar/${w.id}/${w.avatar}`;
                  img.alt = w.name || '';
                  chip.appendChild(img);
                } else {
                  const initial = document.createElement('div');
                  initial.className = 'watcher-avatar';
                  initial.textContent = (w.name || '?').charAt(0).toUpperCase();
                  chip.appendChild(initial);
                }

                const name = document.createElement('span');
                name.textContent = w.name || 'Espectador';
                chip.appendChild(name);

                return chip;
              }),
            );
          } else {
            box.hidden = true;
            list.replaceChildren();
          }
        }
      },
      onAviso: (msg) => {
        if (msg) {
          avisosRecentes.push({ fonte, msg: String(msg).slice(0, 200), t: Date.now() });
          if (avisosRecentes.length > AVISOS_GUARDADOS) avisosRecentes.shift();
        }
        if (!msg) {
          if (broadcaster?.getSettings) {
            const s = broadcaster.getSettings();
            setStatus(
              `Transmitindo · ${s.fps} fps · ${(s.bitrate / 1_000_000).toFixed(1)} Mb/s`,
              'ok',
            );
          }
          return;
        }
        if (msg.startsWith('A captura travou'))
          broadcaster?.diagnosticar?.('tx-captura-travou', {
            fonte,
            gpu: broadcaster?.fabricanteGpu?.() ?? 'desconhecido',
          });
        if (msg === 'Áudio isolado do Firefox ligado.') {
          $('somAba').textContent = 'Reiniciar áudio do Firefox';
          setStatus(msg, 'ok');
        } else {
          setStatus(msg, 'aviso');
        }
      },
      onEnd: (reason) => {
        broadcaster = null;
        if (fonte === 'tela') $('tela-recovery').hidden = true;
        mostrarSetup();
        setStatus(reason);
        if (reason === 'Transmissão substituída pela nova aba.') {
          try {
            window.close();
          } catch {
            /* navegador pode impedir fechar aba que não foi aberta por script */
          }
          setStatus(
            'Transmissão transferida com sucesso para a nova aba. Você já pode fechar esta aba.',
            'ok',
          );
        }
        atualizarStatusGlobal();
      },
      onTrackEnded: () => {
        if (fonte === 'tela') {
          $('tela-recovery').hidden = false;
        } else {
          // Câmera desconectada (cabo puxado, etc)
          if (broadcaster) broadcaster.stop('A câmera foi desconectada.');
        }
      },
      nativeAudioProof,
    });

    // O broadcaster assume as faixas daqui para a frente, então a referência sai
    // sem pará-las — pará-las seria desligar o que acabou de ir ao ar.
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;

    try {
      const stream = await broadcaster.start();
      el('preview').srcObject = stream;
      el('preview')
        .play()
        .catch(() => {});
      el('setup').hidden = true;
      el('live').hidden = false;
      // A tela sempre pede som, e a caixa do seletor pode ter ficado desmarcada:
      // a saída fica à mão desde o início, em vez de só depois de um aviso.
      if (!camera) $('somAba').hidden = false;
      chamar(null);
      if (isTroca) {
        try {
          const bc = new BroadcastChannel('discord-screenshare-focus');
          bc.postMessage({ type: 'substituicao-concluida' });
          bc.close();
        } catch {
          /* canal pode já estar fechado */
        }
      }
      atualizarStatusGlobal();
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      // NotAllowedError quer dizer coisas diferentes nas duas fontes: na tela é
      // quase sempre cancelar o seletor; na câmera é a permissão negada.
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela. Clique no botão acima para escolher novamente.';
      const msg =
        err.name === 'NotAllowedError'
          ? negado
          : err.name === 'InvalidStateError'
            ? 'O navegador exige um clique para abrir a tela. Clique no botão "Escolher janela ou tela" acima.'
            : err.message;
      setStatus(msg, err.name === 'NotAllowedError' ? 'aviso' : 'error');
    } finally {
      ligando = false;
    }
  }

  // O que impede esta fonte, sem derrubar a outra: um celular não tem
  // `getDisplayMedia` e tem `getUserMedia`, então a tela cai e a câmera fica.
  const indisponivel = fonteIndisponivel(fonte);
  if (indisponivel) {
    el('start').disabled = true;
    el('escolher').disabled = true;
    setStatus(indisponivel, 'error');
  }

  el('start').addEventListener('click', ligar);
  el('stop').addEventListener('click', () =>
    broadcaster?.stop(camera ? 'Câmera desligada.' : 'Transmissão encerrada.'),
  );
  if (!camera) {
    $('tela-change')?.addEventListener('click', async () => {
      if (!broadcaster) return;
      try {
        await broadcaster.changeScreen();
        setStatus('Tela alterada com sucesso.');
      } catch (err) {
        if (err.name !== 'NotAllowedError') {
          setStatus(`Erro ao trocar tela: ${err.message}`, 'error');
        }
      }
    });

    $('tela-recover-btn').addEventListener('click', async () => {
      if (!broadcaster) return;
      $('tela-recovery').hidden = true;
      try {
        await broadcaster.changeScreen();
      } catch (err) {
        if (err.name !== 'NotAllowedError') {
          setStatus(`Erro ao recuperar tela: ${err.message}`, 'error');
        }
        $('tela-recovery').hidden = false;
      }
    });
  }

  // stopPropagation para o clique não chegar ao document e fechar o que acabou
  // de abrir.
  el('escolher').addEventListener('click', (e) => {
    e.stopPropagation();
    escolher().catch((err) => setStatus(err.message, 'error'));
  });

  if (camera) {
    document.addEventListener('click', fecharMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') fecharMenu();
    });
  }

  let ultimaTrocaTela = 0;

  return {
    ligar,
    escolher,
    verCamera,
    setStatus,
    indisponivel: () => Boolean(indisponivel),
    aplicarQualidade: () => broadcaster?.setQuality({ bitrate: opcoes.bitrate, fps: opcoes.fps }),
    ativo: () => Boolean(broadcaster),
    diagnosticar: (evento, dados) => broadcaster?.diagnosticar?.(evento, dados),
    // Fechar a aba tem que soltar a câmera, esteja ela no ar ou só na prévia.
    parar: () => {
      broadcaster?.stop();
      pararPrevia();
      atualizarStatusGlobal();
    },
    trocarSom: () => broadcaster?.trocarSom(),
    trocarTela: () => {
      const agora = Date.now();
      if (agora - ultimaTrocaTela < 1000) return null;
      ultimaTrocaTela = agora;
      const promise = broadcaster?.changeScreen();
      if (!promise) {
        ultimaTrocaTela = 0;
        return null;
      }
      return promise.finally(() => {
        ultimaTrocaTela = 0;
      });
    },
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// Firefox recente usa o fallback via <video>. Ele pode custar mais CPU que o
// caminho direto do Chromium, mas bloquear uma capacidade real era pior do que
// oferecer o modo compatível e explicar a diferença.
const missing = supportError();

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e inicie a transmissão novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Volte à atividade no Discord para gerar um novo acesso.');
} else if (missing) {
  falhar('Navegador sem suporte.', missing);
} else {
  for (const f of FONTES) paineis[f] = criarPainel(f);
  ligarControle();

  if (/Firefox\//i.test(navigator.userAgent) && !window.MediaStreamTrackProcessor) {
    $('pageStatus').textContent =
      'Modo Firefox: vídeo em segundo plano e áudio isolado do Firefox serão ligados automaticamente.';
    $('pageStatus').className = 'status aviso';
  }

  // A atividade diz qual fonte motivou a abertura da aba. A tela espera o
  // clique, que é o gesto que o seletor exige; a câmera abre a prévia, mas só
  // depois que a página apareceu — pedir permissão numa aba que o navegador
  // acabou de abrir em segundo plano deixaria o pedido preso sem ninguém ver.
  const pedida = query.get('fonte');
  if (FONTES.includes(pedida)) atenderPedido(pedida);

  if (query.get('troca') === '1') {
    const titleEl = document.querySelector('#tela-setup .empty-title');
    const subEl = document.querySelector('#tela-setup .empty-subtitle');
    const btnText = $('tela-start-text');
    const btnCancel = $('tela-cancelar-troca');

    if (titleEl) titleEl.textContent = 'Trocar de tela ou janela';
    if (subEl)
      subEl.textContent =
        'A transmissão anterior continuará no ar até você confirmar a nova seleção.';
    if (btnText) btnText.textContent = 'Escolher nova tela ou janela';
    if (btnCancel) {
      btnCancel.hidden = false;
      btnCancel.addEventListener('click', () => {
        window.close();
      });
    }
    paineis.tela?.setStatus(
      'A transmissão atual continua no ar. Clique no botão acima para selecionar a nova tela.',
      'aviso',
    );
  }

  atualizarStatusGlobal();
}

// Mantém o vídeo como está e troca só de onde vem o som — as fontes que não
// carregam o Discord junto são uma aba e a janela de um aplicativo.
$('somAba').addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    const result = await paineis.tela.trocarSom();
    if (result?.native) return;
    paineis.tela.setStatus('Áudio conectado da fonte selecionada.', 'ok');
    $('somAba').textContent = 'Trocar a fonte do som';
  } catch (err) {
    // Cancelar a segunda janela é escolha, não falha.
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});

// ------------------------------------------------------------- reportar problema

const BUG_MIN = 10;
let bugEnviando = false;
let bugEnviado = false;
let bugFoco = null;

function contextoDoRelato() {
  const agora = Date.now();
  return {
    avisos: avisosRecentes.map((a) => ({
      fonte: a.fonte,
      msg: a.msg,
      haS: Math.round((agora - a.t) / 1000),
    })),
    stats: Object.fromEntries(
      FONTES.filter((f) => paineis[f]?.ativo() && ultimosStats[f]).map((f) => [f, ultimosStats[f]]),
    ),
    controle: $('control-status').textContent,
    fontesAtivas: FONTES.filter((f) => paineis[f]?.ativo()),
    userAgent: navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/g)?.join(' ') ?? null,
    visibilidade: document.visibilityState,
  };
}

function atualizarBug() {
  const n = $('bug-text').value.length;
  $('bug-count').textContent = `${n} / 2000 · mínimo de ${BUG_MIN} caracteres`;
  $('bug-send').disabled = bugEnviando || bugEnviado || n < BUG_MIN;
}

function mostrarStatusBug(texto, estado) {
  $('bug-status').textContent = texto;
  $('bug-status').className = estado ? `status ${estado}` : 'status';
}

function abrirBug() {
  bugFoco = document.activeElement;
  bugEnviando = false;
  bugEnviado = false;
  $('bug-text').value = '';
  $('bug-text').disabled = false;
  $('bug-cancel').textContent = 'Cancelar';
  mostrarStatusBug('');
  atualizarBug();
  $('bug-modal').hidden = false;
  $('bug-text').focus();
}

function fecharBug() {
  $('bug-modal').hidden = true;
  bugFoco?.focus?.();
}

async function enviarBug() {
  if ($('bug-send').disabled) return;
  bugEnviando = true;
  $('bug-text').disabled = true;
  $('bug-send').textContent = 'Enviando…';
  mostrarStatusBug('');
  atualizarBug();
  try {
    const r = await fetch('/api/relatos/bug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        origem: 'captura',
        texto: $('bug-text').value.trim(),
        contexto: contextoDoRelato(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    bugEnviado = true;
    mostrarStatusBug(`Recebido! Código ${data.id}`, 'ok');
    $('bug-cancel').textContent = 'Fechar';
  } catch (err) {
    // Só mensagem do servidor ou texto fixo daqui; nada de err.message de rede.
    mostrarStatusBug(
      err.name === 'Error' ? err.message : 'Não foi possível falar com o servidor.',
      'error',
    );
    $('bug-text').disabled = false;
  } finally {
    bugEnviando = false;
    $('bug-send').textContent = 'Enviar';
    atualizarBug();
  }
}

$('bug-open').addEventListener('click', abrirBug);
$('bug-text').addEventListener('input', atualizarBug);
$('bug-send').addEventListener('click', enviarBug);
$('bug-cancel').addEventListener('click', fecharBug);
$('bug-modal').addEventListener('click', (e) => {
  if (e.target === $('bug-modal')) fecharBug();
});
document.addEventListener('keydown', (e) => {
  if ($('bug-modal').hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    fecharBug();
    return;
  }
  if (e.key !== 'Tab') return;
  const focaveis = [...$('bug-modal').querySelectorAll('button, textarea')].filter(
    (el) => !el.disabled,
  );
  const primeiro = focaveis[0];
  const ultimo = focaveis.at(-1);
  if (e.shiftKey && document.activeElement === primeiro) {
    e.preventDefault();
    ultimo?.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primeiro?.focus();
  }
});
