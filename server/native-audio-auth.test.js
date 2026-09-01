import { afterEach, describe, expect, it } from 'vitest';
import { createNativeAudioAuthorizer, startNativeAudioLocalServer } from './native-audio-auth.js';

const tokens = new Map([
  ['alice', { room: 'sala', uid: 'alice', role: 'broadcaster' }],
  ['viewer', { room: 'sala', uid: 'alice', role: 'viewer' }],
]);
const verifyToken = (token) => tokens.get(token) ?? null;
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

describe('autorização local do áudio nativo', () => {
  it('vincula uma prova curta à sala e à pessoa transmissora', () => {
    let clock = 1_000;
    const auth = createNativeAudioAuthorizer({ verifyToken, now: () => clock });
    const proof = auth.issue('alice');

    expect(auth.verify(proof, tokens.get('alice'))).toBe(true);
    expect(auth.verify(proof, { ...tokens.get('alice'), uid: 'bob' })).toBe(false);
    clock += 30_001;
    expect(auth.verify(proof, tokens.get('alice'))).toBe(false);
  });

  it('não emite prova para espectador nem token inválido', () => {
    const auth = createNativeAudioAuthorizer({ verifyToken });
    expect(auth.issue('viewer')).toBeNull();
    expect(auth.issue('inventado')).toBeNull();
  });

  it('aceita somente a origem configurada no companion de loopback', async () => {
    const auth = createNativeAudioAuthorizer({ verifyToken });
    const server = await startNativeAudioLocalServer({
      authorizer: auth,
      allowedOrigins: ['https://atividade.example'],
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const negado = await fetch(`${base}/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.example' },
      body: JSON.stringify({ token: 'alice' }),
    });
    expect(negado.status).toBe(403);

    const aceito = await fetch(`${base}/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://atividade.example' },
      body: JSON.stringify({ token: 'alice' }),
    });
    const { proof } = await aceito.json();
    expect(auth.verify(proof, tokens.get('alice'))).toBe(true);
  });
});
