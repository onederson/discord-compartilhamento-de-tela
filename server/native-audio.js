/**
 * Ponte entre a captura WASAPI local e o relay existente.
 *
 * O Firefox não entrega áudio em getDisplayMedia. No Windows, o pequeno helper
 * nativo captura somente a árvore do processo firefox.exe e escreve PCM estéreo
 * no stdout. Aqui os blocos são alinhados em 20 ms e comprimidos em Opus antes
 * de entrar no mesmo protocolo usado pelo áudio capturado no navegador.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpusScript from 'opusscript';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960;
const PCM_BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * 2;
const FRAME_DURATION_US = 20_000;
const FIREFOX_FAMILY_EXECUTABLES = [
  'firefox.exe',
  'librewolf.exe',
  'waterfox.exe',
  'floorp.exe',
  'zen.exe',
  'palemoon.exe',
  'mullvadbrowser.exe',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultHelper = path.join(
  here,
  '..',
  'native',
  'audio-loopback',
  'bin',
  'audio-loopback.exe',
);

const defaultEncoderFactory = () =>
  new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);

export function packNativeAudio(slot, opus, timestamp, sentAt = Date.now()) {
  const packet = Buffer.allocUnsafe(18 + opus.length);
  packet.writeUInt8(slot, 0);
  packet.writeUInt8(3, 1);
  packet.writeDoubleBE(timestamp, 2);
  packet.writeDoubleBE(sentAt, 10);
  Buffer.from(opus).copy(packet, 18);
  return packet;
}

export function createNativeAudioBridge({
  platform = process.platform,
  helperPath = defaultHelper,
  spawnProcess = spawn,
  encoderFactory = defaultEncoderFactory,
  onConfig,
  onPacket,
  onStatus,
  onError,
  readyTimeoutMs = 8_000,
} = {}) {
  let child = null;
  let encoder = null;
  let pcm = Buffer.alloc(0);
  let timestamp = 0;
  let configSent = false;
  let stopping = false;
  let readyTimer = null;

  function clearReadyTimer() {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  }

  function cleanup() {
    clearReadyTimer();
    encoder?.delete?.();
    encoder = null;
    child = null;
    pcm = Buffer.alloc(0);
    timestamp = 0;
    configSent = false;
  }

  function encodeAvailable(chunk) {
    if (!encoder) return;
    pcm = pcm.length ? Buffer.concat([pcm, chunk]) : Buffer.from(chunk);

    while (pcm.length >= PCM_BYTES_PER_FRAME && encoder) {
      const frame = pcm.subarray(0, PCM_BYTES_PER_FRAME);
      pcm = pcm.subarray(PCM_BYTES_PER_FRAME);

      if (!configSent) {
        configSent = true;
        onConfig?.({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
      }

      const opus = Buffer.from(encoder.encode(frame, FRAME_SAMPLES));
      onPacket?.(opus, timestamp);
      timestamp += FRAME_DURATION_US;
    }
  }

  function start(application) {
    if (platform !== 'win32') {
      throw new Error('O áudio isolado por aplicativo exige Windows 10 ou 11.');
    }
    if (application !== 'firefox') {
      throw new Error('A captura nativa desta versão aceita somente o Firefox.');
    }
    if (child) return;

    stopping = false;
    encoder = encoderFactory();
    encoder.setBitrate?.(96_000);

    try {
      child = spawnProcess(helperPath, FIREFOX_FAMILY_EXECUTABLES, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      cleanup();
      throw err;
    }

    child.stdout.on('data', encodeAvailable);

    let stderr = '';
    const diagnostics = [];
    let reported = false;
    const report = (message) => {
      if (reported || stopping) return;
      reported = true;
      onError?.(message);
    };
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      const lines = stderr.split(/\r?\n/);
      stderr = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('READY ')) {
          if (stopping || !child) continue;
          clearReadyTimer();
          onStatus?.('ready', line);
        } else if (line.trim()) {
          diagnostics.push(line.trim());
          onStatus?.('diagnostic', line.trim());
        }
      }
    });

    child.on('error', (err) => {
      report(`Não foi possível iniciar a captura de áudio do navegador: ${err.message}`);
    });
    child.on('exit', (code) => {
      const expected = stopping;
      if (stderr.trim()) diagnostics.push(stderr.trim());
      cleanup();
      if (!expected && code !== 0) {
        const message =
          code === 3
            ? 'Nenhum navegador compatível foi encontrado em execução. Abra e mantenha aberto o Firefox, LibreWolf, Waterfox, Floorp ou Zen e tente novamente.'
            : code >= 4 && code <= 11
              ? 'O Windows não conseguiu abrir a captura de áudio do aplicativo. Atualize o Windows 10/11 e o driver de áudio e tente novamente.'
              : `A captura de áudio do navegador encerrou inesperadamente (código ${code}).`;
        const detalhe = diagnostics.at(-1);
        report(detalhe && code !== 3 ? `${message} Detalhe: ${detalhe}` : message);
      }
    });

    // Um helper pode nascer e ficar preso na ativação do driver sem emitir
    // erro nem READY. Sem prazo, a interface permanece para sempre em
    // "iniciando áudio" e a captura fica órfã. O watchdog encerra apenas esse
    // processo local; o vídeo continua normalmente e a pessoa pode tentar de
    // novo depois de atualizar/reiniciar o driver.
    readyTimer = setTimeout(() => {
      if (!child || stopping) return;
      report(
        'A captura de áudio não respondeu a tempo. Reinicie o navegador ou o dispositivo de áudio e tente novamente.',
      );
      const hangingChild = child;
      stopping = true;
      cleanup();
      hangingChild.kill();
    }, readyTimeoutMs);
    readyTimer.unref?.();
  }

  function stop() {
    if (!child) return;
    stopping = true;
    const runningChild = child;
    cleanup();
    runningChild.kill();
  }

  return { start, stop, active: () => Boolean(child) };
}
