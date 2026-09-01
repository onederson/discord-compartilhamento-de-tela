/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';

const decoders = [];

class DecoderFalso {
  constructor(init) {
    this.init = init;
    this.state = 'unconfigured';
    decoders.push(this);
  }

  configure() {
    this.state = 'configured';
  }

  decode() {}

  close() {
    this.state = 'closed';
  }
}

class ChunkFalso {
  constructor(init) {
    Object.assign(this, init);
  }
}

const config = { codec: 'vp8', codedWidth: 1280, codedHeight: 720 };

function pacote(tipo) {
  const buffer = new ArrayBuffer(19);
  const view = new DataView(buffer);
  view.setUint8(1, tipo);
  view.setFloat64(2, 0);
  view.setFloat64(10, Date.now());
  return buffer;
}

describe('player', () => {
  beforeEach(() => {
    decoders.length = 0;
    vi.stubGlobal('VideoDecoder', DecoderFalso);
    vi.stubGlobal('EncodedVideoChunk', ChunkFalso);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '#000',
    });
  });

  it('pede outro keyframe quando recebe deltas com o decoder frio', () => {
    const onResync = vi.fn();
    const player = createPlayer(document.createElement('canvas'), { onResync });
    player.start(config);

    player.push(pacote(2));
    player.push(pacote(2));

    expect(onResync).toHaveBeenCalledOnce();
  });

  it('pede ressincronização quando o decoder falha', () => {
    const onResync = vi.fn();
    const player = createPlayer(document.createElement('canvas'), { onResync });
    player.start(config);

    decoders.at(-1).init.error(new Error('fluxo quebrado'));

    expect(onResync).toHaveBeenCalledOnce();
  });

  it('considera o primeiro quadro novamente depois de reiniciar na mesma resolução', () => {
    const onTamanho = vi.fn();
    const canvas = document.createElement('canvas');
    const player = createPlayer(canvas, { onTamanho });
    const frame = () => ({ displayWidth: 1280, displayHeight: 720, close: vi.fn() });

    player.start(config);
    decoders.at(-1).init.output(frame());
    player.start(config);
    decoders.at(-1).init.output(frame());

    expect(onTamanho).toHaveBeenCalledTimes(2);
  });

  it('avisa a saúde do stream a cada quadro realmente desenhado', () => {
    const onFrame = vi.fn();
    const player = createPlayer(document.createElement('canvas'), { onFrame });
    const frame = () => ({ displayWidth: 1280, displayHeight: 720, close: vi.fn() });

    player.start(config);
    decoders.at(-1).init.output(frame());
    decoders.at(-1).init.output(frame());

    expect(onFrame).toHaveBeenCalledTimes(2);
  });
});
