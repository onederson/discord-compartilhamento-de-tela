/** Valida o caminho WASAPI → Opus → relay contra o servidor local real. */
import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const WS_BASE = BASE.replace(/^http/, 'ws');

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.received = [];
    ws.on('message', (data, binary) => ws.received.push({ data, binary }));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, predicate, label, timeoutMs = 7000) {
  const existing = ws.received.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', receive);
      reject(new Error(`tempo esgotado esperando ${label}`));
    }, timeoutMs);

    function receive(data, binary) {
      const item = { data, binary };
      if (!predicate(item)) return;
      clearTimeout(timeout);
      ws.off('message', receive);
      resolve(item);
    }
    ws.on('message', receive);
  });
}

const jsonType =
  (type) =>
  ({ data, binary }) => {
    if (binary) return false;
    try {
      return JSON.parse(data.toString()).type === type;
    } catch {
      return false;
    }
  };

const identity = await post('/api/session-dev', {
  instance_id: `audio-${Date.now().toString(36)}`,
  name: 'Teste de áudio',
});
const room = await post('/api/rooms/create', {
  identity: identity.identity,
  name: 'Smoke áudio nativo',
});
const shareToken = new URL(room.shareUrl).searchParams.get('t');

const viewer = await open(`${WS_BASE}/ws?t=${encodeURIComponent(room.viewerToken)}`);
const broadcaster = await open(`${WS_BASE}/ws?t=${encodeURIComponent(shareToken)}&fonte=tela`);

async function localProof() {
  const config = await fetch(`${BASE}/api/config`).then((response) => response.json());
  if (!config.nativeAudioLocalUrl) throw new Error('companion de áudio local indisponível');
  const response = await fetch(`${config.nativeAudioLocalUrl}/proof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(BASE).origin },
    body: JSON.stringify({ token: shareToken }),
  });
  if (!response.ok) throw new Error(`companion recusou a prova: HTTP ${response.status}`);
  return (await response.json()).proof;
}

try {
  const slotMessage = await waitFor(broadcaster, jsonType('slot'), 'slot');
  const slot = JSON.parse(slotMessage.data.toString()).slot;
  broadcaster.send(JSON.stringify({ type: 'start' }));
  await waitFor(viewer, jsonType('stream-start'), 'início da transmissão');
  viewer.send(JSON.stringify({ type: 'watch', slot }));

  broadcaster.send(JSON.stringify({ type: 'native-audio-start', proof: await localProof() }));
  const nativeStatus = await waitFor(
    broadcaster,
    ({ data, binary }) => {
      if (binary) return false;
      try {
        return ['native-audio-ready', 'native-audio-error'].includes(
          JSON.parse(data.toString()).type,
        );
      } catch {
        return false;
      }
    },
    'WASAPI ficar pronto',
    10_000,
  );
  const status = JSON.parse(nativeStatus.data.toString());
  if (status.type === 'native-audio-error') throw new Error(status.message);
  const config = await waitFor(viewer, jsonType('audio-config'), 'config Opus');
  const packet = await waitFor(
    viewer,
    ({ data, binary }) => binary && data[0] === slot && data[1] === 3,
    'primeiro pacote Opus',
  );

  console.log('PASS  WASAPI do Firefox iniciou');
  console.log(`PASS  ${JSON.parse(config.data.toString()).config.codec} chegou ao espectador`);
  console.log(`PASS  pacote de áudio chegou (${packet.data.length} bytes)`);
} finally {
  broadcaster.send(JSON.stringify({ type: 'native-audio-stop' }));
  broadcaster.send(JSON.stringify({ type: 'stop' }));
  broadcaster.close();
  viewer.close();
}
