// @vitest-environment jsdom
/**
 * O pipeline de transmissão, com dublês no lugar do navegador.
 *
 * Nada disto existe fora de um Chromium de verdade: WebCodecs, captura de tela,
 * `MediaStreamTrackProcessor`. Os dublês daqui não imitam o codec — imitam o
 * *contrato*: o encoder aceita configuração, devolve chunk pelo callback de
 * saída, e tem um `state`. É o suficiente para provar o que este módulo
 * realmente decide: qual codec escolher, quando pedir keyframe, quando matar
 * uma faixa de som que traria o Discord de volta em eco, e o que sai no fio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBroadcaster,
  fonteIndisponivel,
  opcoesTela,
  pedirDisplayMedia,
  supportError,
} from './broadcaster.js';

// ------------------------------------------------------------------- dublês

/** Uma fila de leitura controlada pelo teste, no formato do ReadableStream. */
function fila() {
  const prontos = [];
  const esperando = [];
  let encerrada = false;

  return {
    reader: {
      read() {
        if (prontos.length) return Promise.resolve({ done: false, value: prontos.shift() });
        if (encerrada) return Promise.resolve({ done: true });
        return new Promise((resolve) => esperando.push(resolve));
      },
      cancel() {
        encerrada = true;
        esperando.splice(0).forEach((resolve) => resolve({ done: true }));
        return Promise.resolve();
      },
    },
    empurrar(valor) {
      const proximo = esperando.shift();
      if (proximo) proximo({ done: false, value: valor });
      else prontos.push(valor);
    },
  };
}

class FaixaFalsa {
  constructor(kind, settings = {}) {
    this.kind = kind;
    this.settings = settings;
    this.parada = false;
    this.ouvintes = {};
    this.constraints = null;
  }
  getSettings() {
    return this.settings;
  }
  addEventListener(evento, ouvinte) {
    (this.ouvintes[evento] ??= []).push(ouvinte);
  }
  disparar(evento) {
    (this.ouvintes[evento] ?? []).forEach((ouvinte) => ouvinte());
  }
  applyConstraints(constraints) {
    this.constraints = constraints;
    return Promise.resolve();
  }
  stop() {
    this.parada = true;
  }
}

class StreamFalsa {
  constructor(video, audio = null) {
    this.video = video ? [video] : [];
    this.audio = audio ? [audio] : [];
  }
  getVideoTracks() {
    return [...this.video];
  }
  getAudioTracks() {
    return [...this.audio];
  }
  getTracks() {
    return [...this.video, ...this.audio];
  }
  removeTrack(faixa) {
    this.audio = this.audio.filter((a) => a !== faixa);
    this.video = this.video.filter((v) => v !== faixa);
  }
}

/** Um quadro, do tamanho que o teste quiser. */
const quadro = (displayWidth = 1280, displayHeight = 720, timestamp = 1000) => ({
  displayWidth,
  displayHeight,
  timestamp,
  fechado: false,
  close() {
    this.fechado = true;
  },
});

/** Os bytes que todo chunk deste teste carrega. */
const CARGA = [1, 2, 3];

/** Um chunk codificado, no formato que o encoder devolve. */
function chunkFalso({ type = 'key', timestamp = 1000 } = {}) {
  const bytes = new Uint8Array(CARGA);
  return {
    type,
    timestamp,
    byteLength: bytes.byteLength,
    copyTo(destino) {
      destino.set(bytes);
    },
  };
}

let encoders = [];
let audioEncoders = [];
let sockets = [];
let processadores = new Map();
let capturas = [];
let capturasPreparadas = [];
let workers = [];

class WorkerFalso {
  constructor(url) {
    this.url = url;
    this.mensagens = [];
    this.terminado = false;
    workers.push(this);
  }
  postMessage(mensagem) {
    this.mensagens.push(mensagem);
  }
  terminate() {
    this.terminado = true;
  }
}

class VideoEncoderFalso {
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
    this.configuracoes = [];
    this.codificados = [];
    this.resets = 0;
    encoders.push(this);
  }
  configure(config) {
    this.state = 'configured';
    this.configuracoes.push(config);
  }
  encode(frame, opcoes) {
    this.codificados.push({ frame, opcoes });
  }
  reset() {
    this.resets++;
    this.state = 'unconfigured';
    this.encodeQueueSize = 0;
  }
  close() {
    this.state = 'closed';
  }
}
VideoEncoderFalso.isConfigSupported = vi.fn(async (config) => ({
  supported: /^avc1\.42E0/.test(config.codec) && Boolean(config.avc),
  config,
}));

class AudioEncoderFalso {
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.state = 'unconfigured';
    this.codificados = [];
    audioEncoders.push(this);
  }
  configure(config) {
    this.state = 'configured';
    this.config = config;
  }
  encode(dados) {
    this.codificados.push(dados);
  }
  close() {
    this.state = 'closed';
  }
}

class SocketFalso {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.enviados = [];
    this.ouvintes = {};
    this.fechado = false;
    this.bufferedAmount = 0;
    sockets.push(this);
  }
  addEventListener(evento, ouvinte) {
    (this.ouvintes[evento] ??= []).push(ouvinte);
  }
  disparar(evento, dado) {
    (this.ouvintes[evento] ?? []).forEach((ouvinte) => ouvinte(dado));
  }
  abrir(slot = 0) {
    this.readyState = SocketFalso.OPEN;
    this.disparar('open');
    if (slot !== null) this.receber({ type: 'slot', slot });
  }
  receber(objeto) {
    this.disparar('message', { data: JSON.stringify(objeto) });
  }
  send(dado) {
    this.enviados.push(dado);
  }
  close() {
    this.fechado = true;
    this.readyState = 3;
  }
  mensagens() {
    return this.enviados.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
  }
  binarios() {
    return this.enviados.filter((d) => d instanceof ArrayBuffer);
  }
}
SocketFalso.OPEN = 1;

class VideoFrameFalso {
  constructor(fonte, { timestamp } = {}) {
    this.displayWidth = fonte?.width ?? 0;
    this.displayHeight = fonte?.height ?? 0;
    this.timestamp = timestamp;
    this.fonte = fonte;
    this.fechado = false;
  }
  close() {
    this.fechado = true;
  }
}

function processadorDe(track) {
  const existente = processadores.get(track);
  if (existente) return existente;
  const nova = fila();
  processadores.set(track, nova);
  return nova;
}

class ProcessorFalso {
  constructor({ track }) {
    this.readable = { getReader: () => processadorDe(track).reader };
  }
}

/** Deixa os laços assíncronos do módulo andarem. */
const respirar = async (voltas = 4) => {
  for (let i = 0; i < voltas; i++) await new Promise((pronto) => setTimeout(pronto, 0));
};

const prepararCaptura = (stream) => capturasPreparadas.push(stream);

function proximaCaptura() {
  if (!capturasPreparadas.length) throw new Error('nenhuma captura preparada para este teste');
  return capturasPreparadas.shift();
}

/** Instala o navegador de mentira. `sem` remove capacidades, uma a uma. */
function montarNavegador({
  sem = [],
  restrictOwnAudio = true,
  userAgent = 'Mozilla/5.0 Chrome/140.0',
} = {}) {
  const tem = (nome) => !sem.includes(nome);

  vi.stubGlobal('navigator', {
    userAgent,
    mediaDevices: {
      getDisplayMedia: tem('getDisplayMedia')
        ? vi.fn(async (opcoes) => {
            capturas.push(opcoes);
            return proximaCaptura();
          })
        : undefined,
      getUserMedia: tem('getUserMedia')
        ? vi.fn(async (opcoes) => {
            capturas.push(opcoes);
            return proximaCaptura();
          })
        : undefined,
      getSupportedConstraints: () => (restrictOwnAudio ? { restrictOwnAudio: true } : {}),
    },
  });

  window.VideoEncoder = tem('VideoEncoder') ? VideoEncoderFalso : undefined;
  window.VideoFrame = tem('VideoFrame') ? VideoFrameFalso : undefined;
  window.EncodedVideoChunk = tem('EncodedVideoChunk') ? class {} : undefined;
  window.AudioEncoder = tem('AudioEncoder') ? AudioEncoderFalso : undefined;
  window.MediaStreamTrackProcessor = tem('MediaStreamTrackProcessor') ? ProcessorFalso : undefined;

  vi.stubGlobal('VideoEncoder', window.VideoEncoder);
  vi.stubGlobal('VideoFrame', window.VideoFrame);
  vi.stubGlobal('AudioEncoder', window.AudioEncoder);
  vi.stubGlobal('MediaStreamTrackProcessor', window.MediaStreamTrackProcessor);
  vi.stubGlobal('WebSocket', SocketFalso);
  vi.stubGlobal('Worker', tem('Worker') ? WorkerFalso : undefined);
}

const telaSimples = (settings = { width: 1280, height: 720, displaySurface: 'monitor' }) =>
  new StreamFalsa(new FaixaFalsa('video', settings));

const opcoes = (extra = {}) => ({
  wsUrl: 'wss://exemplo.test/ws?t=abc',
  bitrate: 2_500_000,
  fps: 30,
  nativeAudioProof: async () => 'prova-local',
  ...extra,
});

/** Sobe uma transmissão até o `start()` resolver. */
async function noAr(extra = {}, stream = telaSimples()) {
  prepararCaptura(stream);
  const b = createBroadcaster(opcoes(extra));
  const promessa = b.start();
  await respirar();
  sockets.at(-1).abrir();
  await promessa;
  return { b, ws: sockets.at(-1), encoder: encoders.at(-1), stream };
}

beforeEach(() => {
  encoders = [];
  audioEncoders = [];
  sockets = [];
  processadores = new Map();
  capturas = [];
  capturasPreparadas = [];
  workers = [];
  VideoEncoderFalso.isConfigSupported.mockReset();
  VideoEncoderFalso.isConfigSupported.mockImplementation(async (config) => ({
    supported: /^avc1\.42E0/.test(config.codec) && Boolean(config.avc),
    config,
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom não desenha: o canvas do redimensionamento precisa de um contexto.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  montarNavegador();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------- testes

describe('supportError', () => {
  it('não reclama de um navegador completo', () => {
    expect(supportError()).toBeNull();
  });

  it('aponta a falta de WebCodecs', () => {
    montarNavegador({ sem: ['VideoEncoder'] });

    expect(supportError()).toMatch(/não tem WebCodecs/);
  });

  it('deixa passar sem MediaStreamTrackProcessor, a não ser que exijam Chromium', () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });

    expect(supportError()).toBeNull();
    expect(supportError({ requireChromium: true })).toMatch(/exige um navegador Chromium/);
  });
});

describe('fonteIndisponivel', () => {
  it('não reclama de nenhuma das duas num navegador completo', () => {
    expect(fonteIndisponivel('tela')).toBeNull();
    expect(fonteIndisponivel('camera')).toBeNull();
  });

  it('separa as duas: sem captura de tela, a câmera continua valendo', () => {
    montarNavegador({ sem: ['getDisplayMedia'] });

    expect(fonteIndisponivel('tela')).toMatch(/não permite captura de tela/);
    expect(fonteIndisponivel('camera')).toBeNull();
  });

  it('e sem câmera, a tela continua valendo', () => {
    montarNavegador({ sem: ['getUserMedia'] });

    expect(fonteIndisponivel('camera')).toMatch(/não permite acesso à câmera/);
    expect(fonteIndisponivel('tela')).toBeNull();
  });
});

describe('opcoesTela', () => {
  it('prefere a janela inteira e evita oferecer a própria aba primeiro', () => {
    expect(opcoesTela({ fps: 60, comSom: true })).toMatchObject({
      video: {
        displaySurface: 'window',
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
        resizeMode: 'crop-and-scale',
      },
      audio: expect.any(Object),
      monitorTypeSurfaces: 'include',
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      windowAudio: 'window',
      systemAudio: 'include',
      audioSelection: 'preferred',
    });
  });

  it('faz fallback para opções mínimas se o navegador rejeitar opções avançadas com TypeError', async () => {
    const stream = new StreamFalsa(new FaixaFalsa('video', { width: 1280, height: 720 }));
    let tentativas = 0;
    navigator.mediaDevices.getDisplayMedia = vi.fn(async (_opcoes) => {
      tentativas++;
      if (tentativas === 1) {
        throw new TypeError("Failed to read the 'audioSelection' property");
      }
      return stream;
    });

    const res = await pedirDisplayMedia(opcoesTela({ comSom: true }), { comSom: true });
    expect(res).toBe(stream);
    expect(tentativas).toBe(2);
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: true,
    });
  });

  it('repassa erro de cancelamento do usuário sem mascarar', async () => {
    const erroCancelamento = new Error('Permission denied');
    erroCancelamento.name = 'NotAllowedError';
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => {
      throw erroCancelamento;
    });

    await expect(pedirDisplayMedia(opcoesTela())).rejects.toThrow('Permission denied');
  });
});

describe('câmera', () => {
  const camera = () => new StreamFalsa(new FaixaFalsa('video', { width: 1280, height: 720 }));

  it('pede 720p e a taxa escolhida, e nunca o microfone', async () => {
    await noAr({ fonte: 'camera' }, camera());

    expect(capturas[0]).toMatchObject({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
    expect(capturas[0].video).not.toHaveProperty('deviceId');
  });

  it('exige a câmera escolhida, em vez de aceitar outra no lugar', async () => {
    await noAr({ fonte: 'camera', deviceId: 'cam-1' }, camera());

    expect(capturas[0].video.deviceId).toEqual({ exact: 'cam-1' });
  });

  it('marca o conteúdo como vídeo natural, não como texto', async () => {
    const stream = camera();
    await noAr({ fonte: 'camera' }, stream);

    expect(stream.getVideoTracks()[0].contentHint).toBe('motion');
  });

  it('desligar a câmera encerra com a razão certa', async () => {
    const onEnd = vi.fn();
    const stream = camera();
    const { b } = await noAr({ fonte: 'camera', onEnd }, stream);

    stream.getVideoTracks()[0].disparar('ended');

    expect(b.isRunning()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('A câmera foi desligada.');
  });

  it('reaproveita o stream da prévia em vez de abrir a captura de novo', async () => {
    const pronto = camera();

    const b = createBroadcaster(opcoes({ fonte: 'camera', streamPronto: pronto }));
    const promessa = b.start();
    await respirar();
    sockets.at(-1).abrir();

    expect(await promessa).toBe(pronto);
    expect(capturas).toHaveLength(0);
  });
});

describe('start', () => {
  it('espera o slot do servidor antes de iniciar o segundo transmissor', async () => {
    prepararCaptura(telaSimples());
    const b = createBroadcaster(opcoes());
    const promessa = b.start();
    await respirar();
    const ws = sockets.at(-1);

    // Uma VPN ou proxy pode atrasar a primeira mensagem mesmo depois de o
    // WebSocket abrir. O slot 0 não pode ser usado como valor provisório.
    ws.abrir(null);
    await respirar();
    expect(ws.mensagens()).not.toContainEqual({ type: 'start' });
    expect(encoders).toHaveLength(0);

    ws.receber({ type: 'slot', slot: 1 });
    await promessa;
    encoders.at(-1).output(chunkFalso(), {});

    expect(new DataView(ws.binarios()[0]).getUint8(0)).toBe(1);
    b.stop();
  });

  it('escolhe o primeiro codec aceito e configura o encoder com ele', async () => {
    const { encoder } = await noAr();

    expect(encoder.configuracoes[0]).toMatchObject({
      codec: 'avc1.42E01F',
      avc: { format: 'annexb' },
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
      bitrate: 2_500_000,
      framerate: 30,
    });
  });

  it('avisa a interface do codec e do caminho de captura', async () => {
    const onStatus = vi.fn();
    await noAr({ onStatus });

    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ codec: 'avc1.42E01F', direct: true }),
    );
  });

  it('reduz uma tela 4K até o teto de 1920x1080, sem cortar', async () => {
    const { encoder } = await noAr(
      {},
      telaSimples({ width: 3840, height: 2160, displaySurface: 'monitor' }),
    );

    expect(encoder.configuracoes[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('pede ao navegador para reduzir a captura antes de copiar quadros 4K', async () => {
    const stream = telaSimples({ width: 3840, height: 2160, displaySurface: 'monitor' });

    await noAr({ fps: 60 }, stream);

    expect(stream.getVideoTracks()[0].constraints).toMatchObject({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
      resizeMode: 'crop-and-scale',
    });
  });

  it('anuncia H.264 nível 4.2 para 1080p60 em vez do nível 3.0 insuficiente', async () => {
    VideoEncoderFalso.isConfigSupported.mockImplementation(async (config) => ({
      supported: config.codec === 'avc1.42E02A' && Boolean(config.avc),
      config,
    }));

    const { encoder } = await noAr(
      { fps: 60 },
      telaSimples({ width: 1920, height: 1080, displaySurface: 'monitor' }),
    );

    expect(encoder.configuracoes[0].codec).toBe('avc1.42E02A');
  });

  it('avisa o servidor que a transmissão começou', async () => {
    const { ws } = await noAr();

    expect(ws.mensagens()).toContainEqual({ type: 'start' });
  });

  it('desiste quando nenhum codec serve, e solta a captura', async () => {
    VideoEncoderFalso.isConfigSupported.mockResolvedValue({ supported: false });
    const stream = telaSimples();
    prepararCaptura(stream);

    await expect(createBroadcaster(opcoes()).start()).rejects.toThrow(/Nenhum codec/);
    expect(stream.getVideoTracks()[0].parada).toBe(true);
  });

  it('tenta de novo sem latencyMode antes de desistir', async () => {
    VideoEncoderFalso.isConfigSupported.mockImplementation(async (config) => ({
      supported: config.codec === 'vp8' && config.latencyMode === undefined,
    }));

    const { encoder } = await noAr();

    expect(encoder.configuracoes[0].codec).toBe('vp8');
    expect(encoder.configuracoes[0]).not.toHaveProperty('latencyMode');
  });

  it('encerra quando a pessoa para o compartilhamento pelo navegador', async () => {
    const onEnd = vi.fn();
    const { b, stream } = await noAr({ onEnd });

    stream.getVideoTracks()[0].disparar('ended');

    expect(b.isRunning()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('Você parou o compartilhamento pelo navegador.');
  });
});

describe('conexão', () => {
  it('desiste quando o socket falha', async () => {
    prepararCaptura(telaSimples());
    const promessa = createBroadcaster(opcoes()).start();
    await respirar();

    sockets.at(-1).disparar('error');

    await expect(promessa).rejects.toThrow(/Falha ao conectar/);
  });

  it('desiste com a recusa do servidor, quando ela chega antes do ar', async () => {
    prepararCaptura(telaSimples());
    const promessa = createBroadcaster(opcoes()).start();
    await respirar();

    sockets.at(-1).receber({ type: 'error', message: 'Você já está transmitindo nesta sala.' });

    await expect(promessa).rejects.toThrow(/já está transmitindo/);
  });

  it('encerra quando a recusa chega com a transmissão no ar', async () => {
    const onEnd = vi.fn();
    const { b, ws } = await noAr({ onEnd });

    ws.receber({ type: 'error', message: 'sala fechou' });

    expect(b.isRunning()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('sala fechou');
  });

  it('encerra quando a atividade pede', async () => {
    const onEnd = vi.fn();
    const { b, ws } = await noAr({ onEnd });

    ws.receber({ type: 'stop-request' });

    expect(b.isRunning()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('Transmissão encerrada pela atividade.');
  });

  it('tenta reconectar quando a conexão cai sozinha', async () => {
    const onEnd = vi.fn();
    const onAviso = vi.fn();
    const { b, ws } = await noAr({ onEnd, onAviso });

    ws.disparar('close');

    // Com reconexão automática, a transmissão não morre de imediato.
    expect(b.isRunning()).toBe(true);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/Reconectando/));
    expect(onEnd).not.toHaveBeenCalled();

    // Encerra antes que o timer de reconexão dispare sobre os próximos testes.
    b.stop();
    expect(b.isRunning()).toBe(false);
  });

  it('ignora o que chega no socket e não é texto', async () => {
    const { b, ws } = await noAr();

    ws.disparar('message', { data: new ArrayBuffer(4) });

    expect(b.isRunning()).toBe(true);
  });
});

describe('quadros', () => {
  async function comQuadro(frame, extra = {}) {
    const contexto = await noAr(extra);
    const track = contexto.stream.getVideoTracks()[0];
    processadorDe(track).empurrar(frame);
    await respirar();
    return contexto;
  }

  it('codifica o que vem da captura, pedindo keyframe no primeiro', async () => {
    const { encoder } = await comQuadro(quadro());

    expect(encoder.codificados).toHaveLength(1);
    expect(encoder.codificados[0].opcoes).toEqual({ keyFrame: true });
  });

  it('descarta o quadro quando a fila do encoder está cheia', async () => {
    const contexto = await noAr();
    contexto.encoder.encodeQueueSize = 5;
    const frame = quadro();

    processadorDe(contexto.stream.getVideoTracks()[0]).empurrar(frame);
    await respirar();

    expect(contexto.encoder.codificados).toHaveLength(0);
    expect(frame.fechado).toBe(true);
  });

  it('não alimenta o encoder enquanto o WebSocket ainda está congestionado', async () => {
    const contexto = await noAr();
    contexto.ws.bufferedAmount = 10 * 1024 * 1024;
    const frame = quadro();

    processadorDe(contexto.stream.getVideoTracks()[0]).empurrar(frame);
    await respirar();

    expect(contexto.encoder.codificados).toHaveLength(0);
    expect(frame.fechado).toBe(true);
  });

  it('reduz 1080p para 900p quando o encoder não sustenta os quadros', async () => {
    vi.useFakeTimers();
    try {
      const onAviso = vi.fn();
      const stream = telaSimples({ width: 1920, height: 1080, displaySurface: 'monitor' });
      prepararCaptura(stream);
      const b = createBroadcaster(opcoes({ fps: 60, onAviso }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets.at(-1).abrir();
      await promessa;

      const encoder = encoders.at(-1);
      encoder.encodeQueueSize = 5;
      for (let i = 0; i < 20; i++) {
        processadorDe(stream.getVideoTracks()[0]).empurrar(quadro(1920, 1080, i * 16_667));
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(1000);

      encoder.encodeQueueSize = 0;
      processadorDe(stream.getVideoTracks()[0]).empurrar(quadro(1920, 1080, 400_000));
      await vi.advanceTimersByTimeAsync(0);

      expect(encoder.configuracoes.at(-1)).toMatchObject({ width: 1600, height: 900 });
      expect(encoder.resets).toBe(1);
      expect(stream.getVideoTracks()[0].constraints).toMatchObject({
        width: { ideal: 1600, max: 1600 },
        height: { ideal: 900, max: 900 },
      });
      expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/1600×900/));
      b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reduz o bitrate após congestionamento contínuo sem acumular atraso', async () => {
    vi.useFakeTimers();
    try {
      const onAviso = vi.fn();
      const stream = telaSimples();
      prepararCaptura(stream);
      const b = createBroadcaster(opcoes({ bitrate: 8_000_000, fps: 60, onAviso }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      const ws = sockets.at(-1);
      ws.abrir();
      await promessa;

      const streamTrack = stream.getVideoTracks()[0];
      ws.bufferedAmount = 10 * 1024 * 1024;
      for (let segundo = 0; segundo < 2; segundo++) {
        for (let i = 0; i < 20; i++) {
          processadorDe(streamTrack).empurrar(quadro());
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(1000);
      }

      expect(encoders.at(-1).configuracoes.at(-1).bitrate).toBeLessThan(8_000_000);
      expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/rede.*bitrate/i));
      b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reduz o bitrate quando o relay informa espectadores congestionados', async () => {
    vi.useFakeTimers();
    try {
      const onAviso = vi.fn();
      const stream = telaSimples();
      prepararCaptura(stream);
      const b = createBroadcaster(opcoes({ bitrate: 8_000_000, fps: 60, onAviso }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      const ws = sockets.at(-1);
      ws.abrir();
      await promessa;

      ws.receber({ type: 'relay-congestion', droppedViewers: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      ws.receber({ type: 'relay-congestion', droppedViewers: 1 });
      await vi.advanceTimersByTimeAsync(1000);

      expect(encoders.at(-1).configuracoes.at(-1).bitrate).toBeLessThan(8_000_000);
      expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/rede.*bitrate/i));
      b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recupera gradualmente o bitrate depois que a rede estabiliza', async () => {
    vi.useFakeTimers();
    try {
      const onAviso = vi.fn();
      const stream = telaSimples();
      prepararCaptura(stream);
      const b = createBroadcaster(opcoes({ bitrate: 8_000_000, fps: 60, onAviso }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      const ws = sockets.at(-1);
      ws.abrir();
      await promessa;

      const track = stream.getVideoTracks()[0];
      ws.bufferedAmount = 10 * 1024 * 1024;
      for (let segundo = 0; segundo < 2; segundo++) {
        for (let i = 0; i < 20; i++) {
          processadorDe(track).empurrar(quadro());
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const reduzido = encoders.at(-1).configuracoes.at(-1).bitrate;
      expect(reduzido).toBeLessThan(8_000_000);

      ws.bufferedAmount = 0;
      for (let segundo = 0; segundo < 6; segundo++) {
        for (let i = 0; i < 20; i++) {
          processadorDe(track).empurrar(quadro());
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const recuperado = encoders.at(-1).configuracoes.at(-1).bitrate;
      expect(recuperado).toBeGreaterThan(reduzido);
      expect(recuperado).toBeLessThanOrEqual(8_000_000);
      expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/rede estabilizou/i));
      b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconfigura o encoder quando a fonte muda de tamanho', async () => {
    const { encoder, stream } = await comQuadro(quadro(1280, 720));

    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro(3840, 2160));
    await respirar();

    expect(encoder.configuracoes.at(-1)).toMatchObject({ width: 1920, height: 1080 });
  });

  it('não recria o canvas quando a fonte já cabe no teto', async () => {
    await comQuadro(quadro(1280, 720));

    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it('desenha num canvas intermediário quando precisa reduzir', async () => {
    await comQuadro(quadro(3840, 2160));

    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();
  });

  it('empacota slot, tipo e carga no cabeçalho de 18 bytes', async () => {
    const { ws, encoder } = await comQuadro(quadro());
    ws.receber({ type: 'slot', slot: 3 });

    encoder.output(chunkFalso({ type: 'key', timestamp: 4242 }), {});

    const [buffer] = ws.binarios();
    const view = new DataView(buffer);
    expect(view.getUint8(0)).toBe(3);
    expect(view.getUint8(1)).toBe(1);
    expect(view.getFloat64(2)).toBe(4242);
    expect(buffer.byteLength).toBe(18 + CARGA.length);
    expect([...new Uint8Array(buffer, 18)]).toEqual(CARGA);
  });

  it('marca o delta com o tipo próprio', async () => {
    const { ws, encoder } = await comQuadro(quadro());

    encoder.output(chunkFalso({ type: 'delta' }), {});

    expect(new DataView(ws.binarios()[0]).getUint8(1)).toBe(2);
  });

  it('manda a config do decoder junto do primeiro chunk', async () => {
    const { ws, encoder } = await comQuadro(quadro());

    encoder.output(chunkFalso(), {
      decoderConfig: {
        codec: 'avc1.42E01F',
        codedWidth: 1280,
        codedHeight: 720,
        description: new Uint8Array([1, 2, 3]).buffer,
      },
    });

    const config = ws.mensagens().find((m) => m.type === 'config');
    expect(config.config).toMatchObject({ codec: 'avc1.42E01F', codedWidth: 1280 });
    // AQID é base64 de 0x01 0x02 0x03: a descrição vai binária, não como texto.
    expect(config.config.description).toBe('AQID');
  });

  it('não tenta enviar com o socket fechado', async () => {
    const { ws, encoder } = await comQuadro(quadro());
    ws.readyState = 3;

    encoder.output(chunkFalso(), {});

    expect(ws.binarios()).toHaveLength(0);
  });

  it('atende ao pedido de keyframe de quem acabou de chegar', async () => {
    const { encoder, ws, stream } = await comQuadro(quadro());
    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: true });

    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro());
    await respirar();
    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: false });

    ws.receber({ type: 'need-keyframe' });
    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro());
    await respirar();

    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: true });
  });

  it('não codifica depois de parar', async () => {
    const { b, encoder, stream } = await noAr();
    b.stop();

    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro());
    await respirar();

    expect(encoder.codificados).toHaveLength(0);
  });
});

describe('som', () => {
  const comSom = (displaySurface) =>
    new StreamFalsa(
      new FaixaFalsa('video', { width: 1280, height: 720, displaySurface }),
      new FaixaFalsa('audio', { sampleRate: 48_000, channelCount: 2 }),
    );

  it('aceita o som de uma aba, que é isolado por construção', async () => {
    const { b, ws } = await noAr({ audio: true }, comSom('browser'));
    await respirar();

    expect(b.temSom()).toBe(true);
    expect(b.somBloqueado()).toBe(false);
    expect(ws.mensagens()).toContainEqual({
      type: 'audio-config',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    });
  });

  it('aceita o som de uma janela onde o navegador sabe isolá-lo', async () => {
    const { b } = await noAr({ audio: true }, comSom('window'));
    await respirar();

    expect(b.temSom()).toBe(true);
  });

  it('aceita o som da tela inteira quando o usuário o autorizou e avisa sobre eco', async () => {
    const onAviso = vi.fn();
    const stream = comSom('monitor');

    const { b } = await noAr({ audio: true, onAviso }, stream);

    expect(b.somBloqueado()).toBe(false);
    expect(b.temSom()).toBe(true);
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/inclui todos os sons do PC/));
  });

  it('mata o som de janela onde o navegador não sabe isolá-lo', async () => {
    montarNavegador({ restrictOwnAudio: false });
    const onAviso = vi.fn();

    const { b } = await noAr({ audio: true, onAviso }, comSom('window'));

    expect(b.somBloqueado()).toBe(true);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/não isola o som por janela/));
  });

  it('avisa quando uma aba foi escolhida sem a caixa de áudio', async () => {
    const onAviso = vi.fn();

    const { b } = await noAr(
      { audio: true, onAviso },
      telaSimples({ width: 1280, height: 720, displaySurface: 'browser' }),
    );

    expect(b.somBloqueado()).toBe(false);
    expect(b.temSom()).toBe(false);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/Compartilhar áudio da guia/));
  });

  it('mas som que chega de uma superfície não confiável é barrado, e isso se avisa', async () => {
    const onAviso = vi.fn();
    const stream = new StreamFalsa(
      new FaixaFalsa('video', { width: 1280, height: 720, displaySurface: undefined }),
      new FaixaFalsa('audio', { sampleRate: 48_000, channelCount: 2 }),
    );

    const { b } = await noAr({ audio: true, onAviso }, stream);

    expect(b.somBloqueado()).toBe(true);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/de onde vinha esse som/));
  });

  it('oferece áudio de janela e de sistema no seletor', async () => {
    await noAr({ audio: true }, comSom('browser'));

    expect(capturas[0]).toMatchObject({ windowAudio: 'window', systemAudio: 'include' });
    expect(capturas[0].audio).toMatchObject({ echoCancellation: false, restrictOwnAudio: true });
  });

  it('não pede som quando ninguém pediu', async () => {
    await noAr();

    expect(capturas[0].audio).toBe(false);
  });

  it('codifica e envia o som pelo mesmo socket, com tipo próprio', async () => {
    const stream = comSom('browser');
    const { ws } = await noAr({ audio: true }, stream);
    await respirar();
    const dados = { close: vi.fn() };

    processadorDe(stream.getAudioTracks()[0]).empurrar(dados);
    await respirar();
    audioEncoders.at(-1).output(chunkFalso());

    expect(dados.close).toHaveBeenCalled();
    expect(new DataView(ws.binarios().at(-1)).getUint8(1)).toBe(3);
  });

  it('sem AudioEncoder no navegador, a tela continua no ar sem som', async () => {
    montarNavegador({ sem: ['AudioEncoder'] });

    const { b } = await noAr({ audio: true }, comSom('browser'));
    await respirar();

    expect(b.isRunning()).toBe(true);
    expect(b.temSom()).toBe(false);
  });
});

describe('trocarSom', () => {
  const escolha = (displaySurface, comFaixa = true) =>
    new StreamFalsa(
      new FaixaFalsa('video', { displaySurface }),
      comFaixa ? new FaixaFalsa('audio', { sampleRate: 48_000, channelCount: 2 }) : null,
    );

  it('troca só a fonte do som, mantendo o vídeo', async () => {
    const { b, ws } = await noAr({ audio: true }, telaSimples());
    const nova = escolha('browser');
    prepararCaptura(nova);

    const faixa = await b.trocarSom();
    await respirar();

    expect(faixa).toBe(nova.getAudioTracks()[0]);
    expect(b.somBloqueado()).toBe(false);
    // O vídeo da segunda escolha não interessa: viemos só pelo som.
    expect(nova.getVideoTracks()[0].parada).toBe(true);
    expect(ws.mensagens().filter((m) => m.type === 'audio-config')).not.toHaveLength(0);
  });

  it('recusa uma escolha que veio sem som', async () => {
    const { b } = await noAr({ audio: true }, telaSimples());
    prepararCaptura(escolha('browser', false));

    await expect(b.trocarSom()).rejects.toThrow(/veio sem som/);
  });

  it('recusa a tela inteira, que traria o Discord junto', async () => {
    const { b } = await noAr({ audio: true }, telaSimples());
    const nova = escolha('monitor');
    prepararCaptura(nova);

    await expect(b.trocarSom()).rejects.toThrow(/Tela inteira traria o Discord/);
    expect(nova.getAudioTracks()[0].parada).toBe(true);
  });

  it('recusa janela onde o navegador não isola o som', async () => {
    montarNavegador({ restrictOwnAudio: false });
    const { b } = await noAr({ audio: true }, telaSimples());
    prepararCaptura(escolha('window'));

    await expect(b.trocarSom()).rejects.toThrow(/não isola o som por janela/);
  });

  it('avisa quando a fonte nova é fechada', async () => {
    const onAviso = vi.fn();
    const { b } = await noAr({ audio: true, onAviso }, telaSimples());
    prepararCaptura(escolha('browser'));
    const faixa = await b.trocarSom();
    onAviso.mockClear();

    faixa.disparar('ended');

    expect(onAviso).toHaveBeenCalledWith('A fonte do som foi fechada.');
  });
});

describe('changeScreen', () => {
  it('troca a tela sem derrubar a conexão nem o encoder', async () => {
    const { b, ws, encoder, stream } = await noAr();
    const nova = telaSimples({ width: 1920, height: 1080, displaySurface: 'monitor' });
    prepararCaptura(nova);

    const devolvida = await b.changeScreen();
    await respirar();

    expect(devolvida).toBe(nova);
    expect(stream.getVideoTracks()[0].parada).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(encoders).toHaveLength(1);
    expect(ws.fechado).toBe(false);
    expect(encoder.state).toBe('configured');
  });

  it('a tela nova volta a pedir keyframe', async () => {
    const { b, encoder, stream } = await noAr();
    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro());
    await respirar();
    processadorDe(stream.getVideoTracks()[0]).empurrar(quadro());
    await respirar();
    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: false });

    const nova = telaSimples();
    prepararCaptura(nova);
    await b.changeScreen();
    processadorDe(nova.getVideoTracks()[0]).empurrar(quadro());
    await respirar();

    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: true });
  });

  it('encerra quando param o compartilhamento da tela nova', async () => {
    const onEnd = vi.fn();
    const { b } = await noAr({ onEnd });
    const nova = telaSimples();
    prepararCaptura(nova);
    await b.changeScreen();

    nova.getVideoTracks()[0].disparar('ended');

    expect(onEnd).toHaveBeenCalled();
  });

  it('liga o áudio que só apareceu na nova janela compartilhada', async () => {
    const inicial = telaSimples({ width: 1280, height: 720, displaySurface: 'browser' });
    const { b, ws } = await noAr({ audio: true }, inicial);
    const nova = new StreamFalsa(
      new FaixaFalsa('video', { width: 1280, height: 720, displaySurface: 'browser' }),
      new FaixaFalsa('audio', { sampleRate: 48_000, channelCount: 2 }),
    );
    prepararCaptura(nova);

    await b.changeScreen();
    await respirar();

    expect(b.temSom()).toBe(true);
    expect(ws.mensagens()).toContainEqual({
      type: 'audio-config',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    });
  });

  it('fecha o codificador de áudio antigo antes de trocar a janela', async () => {
    const comSom = () =>
      new StreamFalsa(
        new FaixaFalsa('video', { width: 1280, height: 720, displaySurface: 'browser' }),
        new FaixaFalsa('audio', { sampleRate: 48_000, channelCount: 2 }),
      );
    const { b } = await noAr({ audio: true }, comSom());
    await respirar();
    const anterior = audioEncoders.at(-1);
    const nova = comSom();
    prepararCaptura(nova);

    await b.changeScreen();
    await respirar();

    expect(anterior.state).toBe('closed');
    expect(audioEncoders).toHaveLength(2);
    expect(audioEncoders.at(-1).state).toBe('configured');
  });
});

describe('setQuality', () => {
  it('reconfigura o encoder e pede a taxa nova à captura', async () => {
    const { b, encoder, stream } = await noAr();

    b.setQuality({ bitrate: 5_000_000, fps: 60 });

    expect(encoder.configuracoes.at(-1)).toMatchObject({
      codec: 'avc1.42E020',
      bitrate: 5_000_000,
      framerate: 60,
    });
    expect(stream.getVideoTracks()[0].constraints).toMatchObject({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
      resizeMode: 'crop-and-scale',
    });
    expect(stream.getVideoTracks()[0].contentHint).toBe('motion');
    expect(b.getSettings()).toEqual({ bitrate: 5_000_000, fps: 60 });
  });

  it('não faz nada com o encoder fora do ar', async () => {
    const { b, encoder } = await noAr();
    b.stop();

    b.setQuality({ bitrate: 1 });

    expect(encoder.configuracoes).toHaveLength(1);
  });

  it('mantém o que não foi pedido', async () => {
    const { b } = await noAr();

    b.setQuality({});

    expect(b.getSettings()).toEqual({ bitrate: 2_500_000, fps: 30 });
  });
});

describe('estatísticas', () => {
  it('reportam espectadores e os megabits do segundo', async () => {
    vi.useFakeTimers();
    try {
      const onStats = vi.fn();
      prepararCaptura(telaSimples());
      const b = createBroadcaster(opcoes({ onStats }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets.at(-1).abrir();
      await promessa;

      sockets.at(-1).receber({ type: 'state', viewers: 7 });
      encoders.at(-1).output(chunkFalso(), {});
      await vi.advanceTimersByTimeAsync(1000);

      expect(onStats).toHaveBeenCalledWith(
        expect.objectContaining({ viewers: 7, mbps: ((18 + CARGA.length) * 8) / 1e6 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stop', () => {
  it('fecha o encoder, avisa o servidor e derruba a captura', async () => {
    const onEnd = vi.fn();
    const { b, ws, encoder, stream } = await noAr({ onEnd });

    b.stop('acabou');

    expect(encoder.state).toBe('closed');
    expect(ws.mensagens()).toContainEqual({ type: 'stop' });
    expect(ws.fechado).toBe(true);
    expect(stream.getVideoTracks()[0].parada).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('acabou');
  });

  it('parar de novo não avisa de novo', async () => {
    const onEnd = vi.fn();
    const { b } = await noAr({ onEnd });
    b.stop();
    onEnd.mockClear();

    b.stop();

    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('sem MediaStreamTrackProcessor', () => {
  it('cai para o caminho do <video>, e diz isso à interface', async () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });
    const onStatus = vi.fn();

    const { b } = await noAr({ onStatus });

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ direct: false }));
    expect(document.querySelector('video')).not.toBeNull();

    b.stop();
    expect(document.querySelector('video')).toBeNull();
  });

  it('agenda quadros fora da aba por Worker e o encerra junto com a transmissão', async () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });

    const { b } = await noAr();

    expect(workers).toHaveLength(1);
    expect(workers[0].mensagens).toContainEqual({ type: 'start', fps: 30 });

    b.setQuality({ fps: 60 });
    expect(workers[0].mensagens).toContainEqual({ type: 'fps', fps: 60 });

    b.stop();
    expect(workers[0].terminado).toBe(true);
  });

  it('não congela se o Firefox devolver contador de quadros fixo em zero', async () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });
    const { b, encoder } = await noAr();
    const video = document.querySelector('video');
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    video.width = 1280;
    video.height = 720;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 0 });

    workers[0].onmessage({ data: { type: 'tick' } });
    workers[0].onmessage({ data: { type: 'tick' } });

    expect(encoder.codificados).toHaveLength(2);
    b.stop();
  });

  it('mantém o relógio de 60 fps para aba mesmo quando o Firefox limita o contador visível', async () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });
    const stream = telaSimples({ width: 1920, height: 1080, displaySurface: 'browser' });
    const { b, encoder } = await noAr({ fps: 60 }, stream);
    const video = document.querySelector('video');
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
    });
    video.width = 1920;
    video.height = 1080;
    let presented = 1;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: presented });

    workers[0].onmessage({ data: { type: 'tick' } });
    presented = 2;
    workers[0].onmessage({ data: { type: 'tick' } });
    workers[0].onmessage({ data: { type: 'tick' } });

    expect(encoder.codificados).toHaveLength(3);
    b.stop();
  });

  it('gera o keyframe pedido mesmo quando a janela compartilhada está parada', async () => {
    montarNavegador({ sem: ['MediaStreamTrackProcessor'] });
    const stream = telaSimples({ width: 1280, height: 720, displaySurface: 'window' });
    const { b, ws, encoder } = await noAr({}, stream);
    const video = document.querySelector('video');
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    video.width = 1280;
    video.height = 720;
    let presented = 1;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: presented });

    workers[0].onmessage({ data: { type: 'tick' } });
    presented = 2;
    workers[0].onmessage({ data: { type: 'tick' } });
    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: false });

    ws.receber({ type: 'need-keyframe' });
    workers[0].onmessage({ data: { type: 'tick' } });

    expect(encoder.codificados).toHaveLength(3);
    expect(encoder.codificados.at(-1).opcoes).toEqual({ keyFrame: true });
    b.stop();
  });

  it('reduz a captura do Firefox quando a própria fonte entrega só 10 fps', async () => {
    vi.useFakeTimers();
    try {
      montarNavegador({
        sem: ['MediaStreamTrackProcessor'],
        userAgent: 'Mozilla/5.0 Firefox/154.0',
      });
      const stream = telaSimples({ width: 1920, height: 1080, displaySurface: 'window' });
      prepararCaptura(stream);
      const b = createBroadcaster(opcoes({ fps: 60 }));
      const promessa = b.start();
      await vi.advanceTimersByTimeAsync(0);
      sockets.at(-1).abrir();
      await promessa;

      const video = document.querySelector('video');
      Object.defineProperties(video, {
        readyState: { value: 2 },
        videoWidth: { value: 1920 },
        videoHeight: { value: 1080 },
      });
      video.width = 1920;
      video.height = 1080;
      let presented = 0;
      video.getVideoPlaybackQuality = () => ({ totalVideoFrames: presented });
      for (let i = 0; i < 10; i++) {
        presented++;
        workers[0].onmessage({ data: { type: 'tick' } });
      }

      await vi.advanceTimersByTimeAsync(1000);

      expect(stream.getVideoTracks()[0].constraints).toMatchObject({
        width: { ideal: 1600, max: 1600 },
        height: { ideal: 900, max: 900 },
      });
      b.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pede automaticamente o áudio nativo isolado ao transmitir no Firefox', async () => {
    montarNavegador({
      sem: ['MediaStreamTrackProcessor'],
      userAgent: 'Mozilla/5.0 Firefox/154.0',
    });
    const onAviso = vi.fn();
    const { b, ws } = await noAr({ audio: true, onAviso });

    expect(ws.mensagens()).toContainEqual({
      type: 'native-audio-start',
      application: 'firefox',
      proof: 'prova-local',
    });

    ws.receber({ type: 'native-audio-ready', application: 'firefox' });
    expect(b.temSom()).toBe(true);
    expect(onAviso).toHaveBeenCalledWith('Áudio isolado do Firefox ligado.');
    b.stop();
  });

  it('troca o som do Firefox sem abrir outro seletor inútil do navegador', async () => {
    montarNavegador({
      sem: ['MediaStreamTrackProcessor'],
      userAgent: 'Mozilla/5.0 Firefox/154.0',
    });
    const { b, ws } = await noAr({ audio: true });

    const result = await b.trocarSom();

    expect(result).toEqual({ native: true });
    expect(capturas).toHaveLength(1);
    expect(ws.mensagens().filter((m) => m.type === 'native-audio-start')).toHaveLength(2);
    b.stop();
  });

  it('não aciona o helper do anfitrião quando falta a prova local', async () => {
    montarNavegador({
      sem: ['MediaStreamTrackProcessor'],
      userAgent: 'Mozilla/5.0 Firefox/154.0',
    });
    const onAviso = vi.fn();
    const { b, ws } = await noAr({ audio: true, nativeAudioProof: null, onAviso });
    await respirar();

    expect(ws.mensagens().some((m) => m.type === 'native-audio-start')).toBe(false);
    expect(onAviso).toHaveBeenCalledWith(expect.stringMatching(/computador.*INICIAR/i));
    b.stop();
  });
});
