/**
 * Faxina: o fechamento de sala vazia e a poda dos baldes de tráfego.
 *
 * Os dois são movidos pelo relógio, e o intervalo que fecha sala nasce junto
 * com o módulo. Por isso este arquivo é separado: o relógio falso precisa
 * estar de pé *antes* do import, senão o `setInterval` já capturado é o de
 * verdade e nada aqui adianta o tempo dele.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.useFakeTimers();
const R = await import('./rooms.js');

const SWEEP = 4 * 1000;
const CARENCIA = 12 * 1000;
const SEM_PRESENCA = R.SEM_PRESENCA_MS;

let sequencia = 0;
const instancia = () => `faxina-${++sequencia}`;

function socket() {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    recebidas: [],
    send(data) {
      if (typeof data === 'string') this.recebidas.push(JSON.parse(data));
    },
  };
}

function sala() {
  return R.createRoom({ instance: instancia(), ownerId: 'u1', ownerName: 'Alice' }).room;
}

beforeEach(() => {
  // O fechamento se anuncia no log; o teste é sobre a sala, não sobre o texto.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('sala vazia', () => {
  it('sobrevive à carência, e some depois dela', () => {
    const { id } = sala();

    vi.advanceTimersByTime(SWEEP);
    expect(R.getRoom(id)).not.toBeNull();

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(id)).toBeNull();
  });

  it('não fecha enquanto houver alguém dentro', () => {
    const room = sala();
    R.attachViewer(room, socket(), { id: 'espectador', name: 'Quem fica' });

    vi.advanceTimersByTime(CARENCIA * 3);

    expect(R.getRoom(room.id)).toBe(room);
  });

  it('não fecha enquanto quem transmite continuar na sala', () => {
    const room = sala();
    const quem = { id: 'transmissor', name: 'Quem transmite' };
    R.attachBroadcaster(room, socket(), quem);
    // A aba de captura tem conexão própria; quem segura a sala é a presença
    // dessa pessoa na atividade.
    R.attachViewer(room, socket(), quem);

    vi.advanceTimersByTime(CARENCIA * 3);

    expect(R.getRoom(room.id)).toBe(room);
  });

  it('derruba a transmissão de quem saiu da atividade, e aí a sala fecha', () => {
    const room = sala();
    const captura = socket();
    R.attachBroadcaster(room, captura, { id: 'transmissor', name: 'Quem transmite' });

    // Ninguém com esse id está na sala: passada a carência, a aba de captura é
    // avisada e a transmissão encerrada.
    vi.advanceTimersByTime(SEM_PRESENCA + SWEEP * 2);

    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
    expect(room.broadcasters.size).toBe(0);

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(room.id)).toBeNull();
  });

  it('a carência recomeça quando a última pessoa sai', () => {
    const room = sala();
    const viewer = socket();
    R.attachViewer(room, viewer, { id: 'espectador', name: 'Alguém' });
    vi.advanceTimersByTime(CARENCIA * 2);

    R.detachViewer(room, viewer);
    // Sai agora: a primeira varredura só marca o instante em que esvaziou.
    vi.advanceTimersByTime(SWEEP);
    expect(R.getRoom(room.id)).toBe(room);

    vi.advanceTimersByTime(CARENCIA + SWEEP);
    expect(R.getRoom(room.id)).toBeNull();
  });
});

describe('carência de presença do espectador', () => {
  const quem = { id: 'transmissor', name: 'Quem transmite' };

  function cenario() {
    const room = sala();
    const captura = socket();
    R.attachBroadcaster(room, captura, quem);
    const aba = socket();
    R.attachControl(room, aba, quem.id);
    const viewer = socket();
    R.attachViewer(room, viewer, quem);
    return { room, captura, aba, viewer };
  }

  it('não derruba antes do prazo e derruba depois dele', () => {
    const { room, captura, aba, viewer } = cenario();
    R.detachViewer(room, viewer);

    expect(R.agendarEncerramentoPresenca(room, quem.id, 'saiu')).toBe(true);

    vi.advanceTimersByTime(R.VIEWER_GRACE_MS - 1);
    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(false);
    expect(aba.recebidas.some((m) => m.type === 'close-request')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
    expect(aba.recebidas.some((m) => m.type === 'close-request')).toBe(true);
    expect(room.broadcasters.size).toBe(0);
  });

  it('cancela quando o espectador reconecta dentro do prazo', () => {
    const { room, captura, aba, viewer } = cenario();
    R.detachViewer(room, viewer);
    R.agendarEncerramentoPresenca(room, quem.id, 'saiu');

    vi.advanceTimersByTime(R.VIEWER_GRACE_MS / 2);
    R.attachViewer(room, socket(), quem);

    vi.advanceTimersByTime(R.VIEWER_GRACE_MS * 2);
    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(false);
    expect(aba.recebidas.some((m) => m.type === 'close-request')).toBe(false);
    expect(room.broadcasters.size).toBe(1);
  });

  it('não agenda nada quando a pessoa não tem transmissão nem aba de captura', () => {
    const room = sala();
    expect(R.agendarEncerramentoPresenca(room, 'ninguem', 'saiu')).toBe(false);
    expect(room.presencaTimers.size).toBe(0);
  });

  it('com carência zero, encerra na hora', () => {
    const { room, captura, viewer } = cenario();
    R.detachViewer(room, viewer);

    R.agendarEncerramentoPresenca(room, quem.id, 'saiu', 0);

    expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
  });

  it('o encerramento explícito (/leave) cancela o agendamento pendente', () => {
    const { room, viewer } = cenario();
    R.detachViewer(room, viewer);
    R.agendarEncerramentoPresenca(room, quem.id, 'saiu');

    R.encerrarPresenca(room, quem.id);

    expect(room.presencaTimers.size).toBe(0);
  });

  describe('com a aba de captura viva e alguém assistindo', () => {
    function comPlateia() {
      const c = cenario();
      const plateia = socket();
      R.attachViewer(c.room, plateia, { id: 'espectador', name: 'Quem assiste' });
      R.detachViewer(c.room, c.viewer);
      return { ...c, plateia };
    }

    it('mantém a transmissão no ar e avisa a aba', () => {
      const { room, captura, aba } = comPlateia();
      const aoEncerrar = vi.fn();
      const aoManter = vi.fn();
      R.agendarEncerramentoPresenca(room, quem.id, 'saiu', undefined, aoEncerrar, aoManter);

      // Passa da carência e da varredura de quem ficou sem presença.
      vi.advanceTimersByTime(R.VIEWER_GRACE_MS + SEM_PRESENCA + SWEEP * 2);

      expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(false);
      expect(aba.recebidas.some((m) => m.type === 'close-request')).toBe(false);
      expect(aba.recebidas.some((m) => m.type === 'atividade-fechada')).toBe(true);
      expect(room.broadcasters.size).toBe(1);
      expect(aoManter).toHaveBeenCalledWith(1);
      expect(aoEncerrar).not.toHaveBeenCalled();
    });

    it('avisa a aba quando a pessoa reabre a atividade', () => {
      const { room, aba } = comPlateia();
      R.agendarEncerramentoPresenca(room, quem.id, 'saiu');
      vi.advanceTimersByTime(R.VIEWER_GRACE_MS);

      R.attachViewer(room, socket(), quem);

      expect(aba.recebidas.at(-1)?.type).toBe('atividade-voltou');
    });

    it('encerra quando a plateia vai embora', () => {
      const { room, captura, plateia } = comPlateia();
      R.agendarEncerramentoPresenca(room, quem.id, 'saiu');
      vi.advanceTimersByTime(R.VIEWER_GRACE_MS);

      R.detachViewer(room, plateia);
      vi.advanceTimersByTime(SEM_PRESENCA + SWEEP * 2);

      expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
      expect(room.broadcasters.size).toBe(0);
    });

    it('encerra quando a aba de captura cai', () => {
      const { room, captura, aba } = comPlateia();
      R.agendarEncerramentoPresenca(room, quem.id, 'saiu');
      vi.advanceTimersByTime(R.VIEWER_GRACE_MS);

      R.detachControl(room, aba);
      vi.advanceTimersByTime(SEM_PRESENCA + SWEEP * 2);

      expect(captura.recebidas.some((m) => m.type === 'stop-request')).toBe(true);
      expect(room.broadcasters.size).toBe(0);
    });
  });
});

describe('baldes de tráfego', () => {
  it('guardam só o último minuto', () => {
    const room = sala();
    const ws = socket();
    const entry = R.attachBroadcaster(room, ws, { id: 'transmissor', name: 'T' });
    R.startStream(room, entry);
    const chunk = Buffer.alloc(64);
    chunk[0] = entry.slot;
    chunk[1] = 1;

    R.pushChunk(room, entry, chunk);
    const primeiroSegundo = Math.floor(Date.now() / 1000);
    expect(room.traffic.buckets.has(primeiroSegundo)).toBe(true);

    vi.advanceTimersByTime(90 * 1000);
    R.pushChunk(room, entry, chunk);

    expect(room.traffic.buckets.has(primeiroSegundo)).toBe(false);
    // O acumulado não some junto: o que é podado é a série por segundo.
    expect(room.traffic.receivedBytes).toBe(128);
  });
});
