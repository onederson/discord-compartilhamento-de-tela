import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAudioBridge, packNativeAudio } from './native-audio.js';

function dependencies(platform = 'win32') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  const encoded = [];
  const encoder = {
    encode: vi.fn((pcm, frames) => {
      encoded.push(Buffer.from(pcm));
      return Buffer.from([frames & 0xff, encoded.length]);
    }),
    delete: vi.fn(),
  };

  return {
    child,
    encoder,
    spawnProcess: vi.fn(() => child),
    encoderFactory: vi.fn(() => encoder),
    options: { platform, helperPath: 'audio-loopback.exe' },
  };
}

describe('captura nativa de áudio', () => {
  it('empacota o Opus no mesmo protocolo binário da transmissão', () => {
    const packet = packNativeAudio(2, Buffer.from([7, 8, 9]), 40_000, 1234);

    expect(packet[0]).toBe(2);
    expect(packet[1]).toBe(3);
    expect(packet.readDoubleBE(2)).toBe(40_000);
    expect(packet.readDoubleBE(10)).toBe(1234);
    expect([...packet.subarray(18)]).toEqual([7, 8, 9]);
  });

  it('tenta Firefox e derivados conhecidos sem aceitar processo vindo da rede', () => {
    const d = dependencies();
    const onConfig = vi.fn();
    const onPacket = vi.fn();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
      onConfig,
      onPacket,
    });

    bridge.start('firefox');
    expect(d.spawnProcess).toHaveBeenCalledWith(
      'audio-loopback.exe',
      [
        'firefox.exe',
        'librewolf.exe',
        'waterfox.exe',
        'floorp.exe',
        'zen.exe',
        'palemoon.exe',
        'mullvadbrowser.exe',
      ],
      expect.objectContaining({ windowsHide: true }),
    );

    d.child.stderr.write('READY 3940 48000 2 s16le\n');
    d.child.stdout.write(Buffer.alloc(1000, 1));
    d.child.stdout.write(Buffer.alloc(6680, 2));

    expect(onConfig).toHaveBeenCalledOnce();
    expect(onConfig).toHaveBeenCalledWith({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    expect(d.encoder.encode).toHaveBeenCalledTimes(2);
    expect(d.encoder.encode).toHaveBeenNthCalledWith(1, expect.any(Buffer), 960);
    expect(onPacket.mock.calls.map(([, timestamp]) => timestamp)).toEqual([0, 20_000]);
  });

  it('encerra o processo e libera o encoder sem deixar captura órfã', () => {
    const d = dependencies();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
    });

    bridge.start('firefox');
    bridge.stop();

    expect(d.child.kill).toHaveBeenCalledOnce();
    expect(d.encoder.delete).toHaveBeenCalledOnce();
    expect(bridge.active()).toBe(false);
  });

  it('recusa captura nativa fora do Windows', () => {
    const d = dependencies('linux');
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
    });

    expect(() => bridge.start('firefox')).toThrow(/Windows 10 ou 11/);
    expect(d.spawnProcess).not.toHaveBeenCalled();
  });

  it('não aceita nomes arbitrários de processo vindos da rede', () => {
    const d = dependencies();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
    });

    expect(() => bridge.start('discord')).toThrow(/Firefox/);
    expect(d.spawnProcess).not.toHaveBeenCalled();
  });

  it('não abre dois helpers e parar sem captura é inofensivo', () => {
    const d = dependencies();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
    });

    bridge.stop();
    bridge.start('firefox');
    bridge.start('firefox');
    expect(d.spawnProcess).toHaveBeenCalledOnce();
  });

  it('classifica status e diagnóstico emitidos pelo helper', () => {
    const d = dependencies();
    const onStatus = vi.fn();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
      onStatus,
    });

    bridge.start('firefox');
    d.child.stderr.write('READY 42');
    d.child.stderr.write(' 48000 2 s16le\naviso útil\n\n');

    expect(onStatus).toHaveBeenNthCalledWith(1, 'ready', 'READY 42 48000 2 s16le');
    expect(onStatus).toHaveBeenNthCalledWith(2, 'diagnostic', 'aviso útil');
  });

  it('propaga falha ao criar o processo e volta ao estado inativo', () => {
    const d = dependencies();
    const failure = new Error('helper ausente');
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: vi.fn(() => {
        throw failure;
      }),
      encoderFactory: d.encoderFactory,
    });

    expect(() => bridge.start('firefox')).toThrow(failure);
    expect(d.encoder.delete).toHaveBeenCalledOnce();
    expect(bridge.active()).toBe(false);
  });

  it('não duplica o erro de spawn quando o processo também encerra', () => {
    const d = dependencies();
    const onError = vi.fn();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
      onError,
    });

    bridge.start('firefox');
    d.child.emit('error', new Error('acesso negado'));
    d.child.emit('exit', 7);

    expect(onError).toHaveBeenNthCalledWith(
      1,
      'Não foi possível iniciar a captura de áudio do navegador: acesso negado',
    );
    expect(onError).toHaveBeenCalledOnce();

    const inesperado = dependencies();
    const unexpectedError = vi.fn();
    const unexpectedBridge = createNativeAudioBridge({
      ...inesperado.options,
      spawnProcess: inesperado.spawnProcess,
      encoderFactory: inesperado.encoderFactory,
      onError: unexpectedError,
    });
    unexpectedBridge.start('firefox');
    inesperado.child.emit('exit', 7);
    expect(unexpectedError).toHaveBeenCalledWith(
      'O Windows não conseguiu abrir a captura de áudio do aplicativo. Atualize o Windows 10/11 e o driver de áudio e tente novamente.',
    );

    const normal = dependencies();
    const normalError = vi.fn();
    const normalBridge = createNativeAudioBridge({
      ...normal.options,
      spawnProcess: normal.spawnProcess,
      encoderFactory: normal.encoderFactory,
      onError: normalError,
    });
    normalBridge.start('firefox');
    normal.child.emit('exit', 0);
    expect(normalError).not.toHaveBeenCalled();
  });

  it('traduz o código 3 em uma orientação útil para derivados do Firefox', () => {
    const d = dependencies();
    const onError = vi.fn();
    const bridge = createNativeAudioBridge({
      ...d.options,
      spawnProcess: d.spawnProcess,
      encoderFactory: d.encoderFactory,
      onError,
    });

    bridge.start('firefox');
    d.child.stderr.write('ERROR processo compativel nao encontrado\n');
    d.child.emit('exit', 3);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatch(/Firefox, LibreWolf, Waterfox, Floorp ou Zen/i);
    expect(onError.mock.calls[0][0]).not.toMatch(/código 3/);
  });

  it('encerra o helper que nasce mas não confirma que está pronto', async () => {
    vi.useFakeTimers();
    try {
      const d = dependencies();
      const onError = vi.fn();
      const bridge = createNativeAudioBridge({
        ...d.options,
        spawnProcess: d.spawnProcess,
        encoderFactory: d.encoderFactory,
        onError,
        readyTimeoutMs: 250,
      });

      bridge.start('firefox');
      await vi.advanceTimersByTimeAsync(250);

      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/não respondeu a tempo/i));
      expect(d.child.kill).toHaveBeenCalledOnce();
      expect(d.encoder.delete).toHaveBeenCalledOnce();
      expect(bridge.active()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancela o watchdog quando o helper confirma READY', async () => {
    vi.useFakeTimers();
    try {
      const d = dependencies();
      const onError = vi.fn();
      const bridge = createNativeAudioBridge({
        ...d.options,
        spawnProcess: d.spawnProcess,
        encoderFactory: d.encoderFactory,
        onError,
        readyTimeoutMs: 250,
      });

      bridge.start('firefox');
      d.child.stderr.write('READY 42 48000 2 s16le\n');
      await vi.advanceTimersByTimeAsync(500);

      expect(onError).not.toHaveBeenCalled();
      expect(d.child.kill).not.toHaveBeenCalled();
      expect(bridge.active()).toBe(true);
      bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
