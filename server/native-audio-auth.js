import crypto from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY = 16 * 1024;

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** Provas curtas e efêmeras de que a página alcançou o companion local. */
export function createNativeAudioAuthorizer({ verifyToken, now = () => Date.now() } = {}) {
  const secret = crypto.randomBytes(32);
  const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

  function issue(token) {
    const auth = verifyToken?.(token);
    if (!auth || auth.role !== 'broadcaster' || !auth.room || !auth.uid) return null;

    const body = Buffer.from(
      JSON.stringify({ room: auth.room, uid: auth.uid, exp: now() + 30_000 }),
    ).toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function verify(proof, auth) {
    if (typeof proof !== 'string') return false;
    const [body, signature] = proof.split('.');
    if (!body || !signature || !safeEqual(signature, sign(body))) return false;

    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return (
        claims.exp >= now() &&
        claims.room === auth?.room &&
        claims.uid === auth?.uid &&
        auth?.role === 'broadcaster'
      );
    } catch {
      return false;
    }
  }

  return { issue, verify };
}

/**
 * Companion HTTP preso a 127.0.0.1 e a uma porta que o sistema escolhe.
 * O túnel aponta para outra porta, portanto este endpoint não existe na URL
 * pública. Alcançá-lo é a prova de que navegador e capturador estão no mesmo PC.
 */
export function startNativeAudioLocalServer({ authorizer, allowedOrigins = [] } = {}) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) {
      res.writeHead(403).end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/proof') {
      res.writeHead(404).end();
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let token;
      try {
        token = JSON.parse(Buffer.concat(chunks).toString('utf8')).token;
      } catch {
        res.writeHead(400).end();
        return;
      }

      const proof = authorizer.issue(token);
      if (!proof) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proof }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.unref();
      resolve(server);
    });
  });
}
