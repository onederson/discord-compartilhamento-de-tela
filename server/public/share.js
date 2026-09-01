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
} from '/shared/broadcaster.js?v=11';

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

function aplicarOpcoes(novas) {
  if (!novas) return;
  if (Number(novas.q)) opcoes.bitrate = Number(novas.q);
  if (Number(novas.fps)) opcoes.fps = Number(novas.fps);
}

const paineis = {};

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  // Título e motivo no mesmo lugar: sem o cabeçalho não há mais onde separar
  // os dois, e separados em duas linhas eles diziam a mesma coisa duas vezes.
  const el = $('pageStatus');
  el.textContent = `${titulo} ${msg}`;
  el.className = 'status error';
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
  if (fonte === 'camera') painel.verCamera();
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

function ligarControle() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  controle = new WebSocket(
    `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&modo=controle`,
  );

  controle.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === 'start-request') atenderPedido(msg.fonte, msg.opcoes);
    else if (msg.type === 'config-request') aplicarConfig(msg.opcoes);
    else if (msg.type === 'room-gone') {
      // Sala fechada: não há a quem transmitir, e insistir na reconexão só
      // gastaria rede contra um id que não existe mais.
      clearTimeout(religar);
      religar = 'morto';
      $('pageStatus').textContent = 'A sala foi fechada. Volte à atividade e comece de novo.';
      $('pageStatus').className = 'status aviso';
    }
  });

  // Sem reconectar, uma queda de rede deixa a aba aberta e surda, sem nada na
  // tela dizendo que ela parou de obedecer à atividade.
  controle.addEventListener('close', () => {
    controle = null;
    if (religar === 'morto') return;
    clearTimeout(religar);
    religar = setTimeout(ligarControle, 3000);
  });
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;

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
        setStatus(camera ? 'A câmera foi desligada.' : 'O compartilhamento acabou.');
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
      setStatus('Prévia — ainda não está no ar.');
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
      const s = await navigator.mediaDevices.getDisplayMedia(
        opcoesTela({ fps: opcoes.fps, comSom: true }),
      );
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia — ainda não está no ar.');
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
    if (broadcaster) return;

    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';

    broadcaster = createBroadcaster({
      wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}`,
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
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('fps').title =
          `Quadros recebidos da fonte: ${s.captureFps} · enviados: ${s.fps} · descartados: ${s.droppedFrames}`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;

        if ($('liveViewers')) $('liveViewers').textContent = s.viewers;
        if ($('liveFps')) $('liveFps').textContent = `${s.fps} fps`;
        if ($('liveBitrate')) $('liveBitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        if ($('liveElapsed')) {
          $('liveElapsed').textContent =
            `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
        }
      },
      onAviso: (msg) => {
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
        $('liveView').hidden = true;
        $('stepSource').hidden = false;
        $('stepSettings').hidden = true;
        setStatus(reason);
      },
      onTrackEnded: () => {
        if (fonte === 'tela') {
          $('tela-recovery').hidden = false;
          if ($('recoveryView')) $('recoveryView').hidden = false;
        } else {
          if (broadcaster) broadcaster.stop('A câmera foi desconectada.');
        }
      },
      nativeAudioProof,
    });

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

      $('stepSource').hidden = true;
      $('stepSettings').hidden = true;
      $('liveView').hidden = false;
      if ($('livePreview')) {
        $('livePreview').srcObject = stream;
        $('livePreview').play().catch(() => {});
      }

      if (!camera) $('somAba').hidden = false;
      chamar(null);
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela.';
      setStatus(err.name === 'NotAllowedError' ? negado : err.message, 'error');
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

    $('btnRecover')?.addEventListener('click', async () => {
      if (!broadcaster) return;
      $('recoveryView').hidden = true;
      try {
        await broadcaster.changeScreen();
      } catch (err) {
        if (err.name !== 'NotAllowedError') {
          setStatus(`Erro ao recuperar tela: ${err.message}`, 'error');
        }
        $('recoveryView').hidden = false;
      }
    });

    $('btnStopLive')?.addEventListener('click', () => {
      broadcaster?.stop('Transmissão encerrada.');
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

  return {
    ligar,
    escolher,
    verCamera,
    setStatus,
    indisponivel: () => Boolean(indisponivel),
    aplicarQualidade: () => broadcaster?.setQuality({ bitrate: opcoes.bitrate, fps: opcoes.fps }),
    ativo: () => Boolean(broadcaster),
    parar: () => {
      broadcaster?.stop();
      pararPrevia();
    },
    trocarSom: () => broadcaster?.trocarSom(),
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
const missing = supportError();

function calcularBitrateSS(res, fps) {
  if (fps === 60) {
    if (res === '1440' || res === 'source') return 8_000_000;
    if (res === '1080') return 6_000_000;
    return 3_000_000;
  }
  if (fps === 30) {
    if (res === '1440' || res === 'source') return 5_000_000;
    if (res === '1080') return 3_000_000;
    return 1_800_000;
  }
  if (res === '1440' || res === 'source') return 3_000_000;
  if (res === '1080') return 2_000_000;
  return 1_000_000;
}

let ssSelectedSource = {
  type: 'screen',
  name: 'Tela 3',
  surface: 'monitor',
};
let ssSelectedResolution = '1440';
let ssSelectedFps = 60;

function setupDiscordSSUI() {
  if (payload?.name && $('channelName')) {
    $('channelName').textContent = `Canal de ${payload.name}`;
  }

  for (const tab of document.querySelectorAll('.discord-ss-tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.discord-ss-tab')) {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      }
      for (const panel of document.querySelectorAll('.discord-ss-panel')) {
        panel.classList.toggle(
          'active',
          panel.id === `tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`,
        );
      }
    });
  }

  for (const item of document.querySelectorAll('.discord-ss-item')) {
    item.addEventListener('click', () => {
      for (const it of document.querySelectorAll('.discord-ss-item')) {
        it.classList.toggle('selected', it === item);
      }
      ssSelectedSource = {
        type: item.dataset.sourceType || 'screen',
        name: item.dataset.sourceName || 'Tela 1',
        surface: item.dataset.surface || 'monitor',
      };
      if ($('ssSelectedName')) $('ssSelectedName').textContent = ssSelectedSource.name;
    });
    item.addEventListener('dblclick', () => {
      $('stepSource').hidden = true;
      $('stepSettings').hidden = false;
    });
  }

  $('btnGoLiveStep1')?.addEventListener('click', () => {
    $('stepSource').hidden = true;
    $('stepSettings').hidden = false;
  });

  $('btnBackToStep1')?.addEventListener('click', () => {
    $('stepSettings').hidden = true;
    $('stepSource').hidden = false;
  });

  $('btnChangeSource')?.addEventListener('click', () => {
    $('stepSettings').hidden = true;
    $('stepSource').hidden = false;
  });

  for (const pill of document.querySelectorAll('#resolutionPills .discord-ss-pill')) {
    pill.addEventListener('click', () => {
      for (const p of document.querySelectorAll('#resolutionPills .discord-ss-pill')) {
        p.classList.toggle('active', p === pill);
      }
      ssSelectedResolution = pill.dataset.res;
      if ($('qualityPreset')) $('qualityPreset').value = 'custom';
      opcoes.bitrate = calcularBitrateSS(ssSelectedResolution, ssSelectedFps);
    });
  }

  for (const pill of document.querySelectorAll('#fpsPills .discord-ss-pill')) {
    pill.addEventListener('click', () => {
      for (const p of document.querySelectorAll('#fpsPills .discord-ss-pill')) {
        p.classList.toggle('active', p === pill);
      }
      ssSelectedFps = Number(pill.dataset.fps);
      opcoes.fps = ssSelectedFps;
      if ($('qualityPreset')) $('qualityPreset').value = 'custom';
      opcoes.bitrate = calcularBitrateSS(ssSelectedResolution, ssSelectedFps);
    });
  }

  $('qualityPreset')?.addEventListener('change', (e) => {
    if (e.target.value === 'smoother') {
      ssSelectedResolution = '1080';
      ssSelectedFps = 60;
    } else if (e.target.value === 'better_text') {
      ssSelectedResolution = '1440';
      ssSelectedFps = 30;
    }
    opcoes.fps = ssSelectedFps;
    opcoes.bitrate = calcularBitrateSS(ssSelectedResolution, ssSelectedFps);
    for (const p of document.querySelectorAll('#resolutionPills .discord-ss-pill')) {
      p.classList.toggle('active', p.dataset.res === ssSelectedResolution);
    }
    for (const p of document.querySelectorAll('#fpsPills .discord-ss-pill')) {
      p.classList.toggle('active', Number(p.dataset.fps) === ssSelectedFps);
    }
  });

  $('btnGoLive')?.addEventListener('click', () => {
    const f = ssSelectedSource.surface === 'camera' ? 'camera' : 'tela';
    paineis[f]?.ligar();
  });
}

setupDiscordSSUI();

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Gere um novo pela atividade.');
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
}

// Mantém o vídeo como está e troca só de onde vem o som — as fontes que não
// carregam o Discord junto são uma aba e a janela de um aplicativo.
$('somAba').addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    const result = await paineis.tela.trocarSom();
    if (result?.native) return;
    paineis.tela.setStatus('Som ligado, vindo da fonte escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a fonte do som';
  } catch (err) {
    // Cancelar a segunda janela é escolha, não falha.
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});
