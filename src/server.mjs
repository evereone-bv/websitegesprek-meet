// Meetserver van Websitegesprek. Luistert alleen op localhost; Caddy zet er https voor (deploy/Caddyfile).
// Routes:
//   GET  /healthz                 levensteken
//   GET  /v1/pubkey               openbare sleutel van deze meetserver (rapportage zet die vast)
//   POST /v1/measure              ondertekende meetopdracht van rapportage (doel: meten, "voor_na" of sinds 0.3.0 "volgcodes")
//   GET  /v1/plaatje/<token>.jpg  klein plaatje, 15 minuten geldig, daarna weg
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runJob, JobError } from './measure.mjs';
import { GuardError } from './guard.mjs';
import { REQ_PREFIX, RESP_PREFIX, MAX_SKEW_S, message, sign, verify, publicKeyFromRaw, loadOrCreateServerKey, NonceCache } from './keys.mjs';

export const VERSION = '0.3.0';

export function createServer(cfg) {
  const clientKeys = cfg.clientKeys.map(publicKeyFromRaw);
  const serverKey = loadOrCreateServerKey(cfg.dataDir);
  const nonces = new NonceCache();
  const shots = new Map();
  let shotBytes = 0;
  let running = 0;
  const queue = [];

  const storeShot = (buf) => {
    const now = Date.now();
    for (const [k, s] of shots) if (s.exp < now) { shots.delete(k); shotBytes -= s.buf.length; }
    while (shotBytes + buf.length > cfg.maxShotBytes && shots.size) {
      const [k, s] = shots.entries().next().value;
      shots.delete(k);
      shotBytes -= s.buf.length;
    }
    const token = crypto.randomBytes(18).toString('base64url');
    shots.set(token, { buf, exp: now + cfg.shotTtlMs });
    shotBytes += buf.length;
    return `${cfg.publicBase}/v1/plaatje/${token}.jpg`;
  };

  const acquire = () => new Promise((resolve, reject) => {
    if (running < cfg.maxConcurrent) { running++; return resolve(); }
    if (queue.length >= cfg.maxQueue) return reject(new JobError('druk', 'De meetserver is even druk. Probeer het over een minuut opnieuw.'));
    queue.push(resolve);
  });
  const release = () => {
    const next = queue.shift();
    if (next) next(); else running--;
  };

  const log = (o) => { if (!cfg.quiet) console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); };

  const sendSigned = (res, status, obj, nonce) => {
    const body = Buffer.from(JSON.stringify(obj));
    const ts = String(Math.floor(Date.now() / 1000));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-WG-Ts': ts,
      'X-WG-Nonce': nonce || '',
      'X-WG-Signature': sign(serverKey.privateKey, message(RESP_PREFIX, ts, nonce || '', body)),
    });
    res.end(body);
  };

  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new JobError('te_groot', 'Opdracht te groot.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const path = (req.url || '').split('?')[0];
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, versie: VERSION, bezig: running, wachtrij: queue.length }));
      }
      if (req.method === 'GET' && path === '/v1/pubkey') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ alg: 'ed25519', key: serverKey.publicRaw, versie: VERSION }));
      }
      const m = path.match(/^\/v1\/plaatje\/([A-Za-z0-9_-]{24})\.jpg$/);
      if (req.method === 'GET' && m) {
        const s = shots.get(m[1]);
        if (!s || s.exp < Date.now()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Dit plaatje is verlopen (15 minuten geldig).'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': s.buf.length });
        return res.end(s.buf);
      }
      if (req.method === 'POST' && path === '/v1/measure') {
        const ts = String(req.headers['x-wg-ts'] || '');
        const nonce = String(req.headers['x-wg-nonce'] || '');
        const sig = String(req.headers['x-wg-signature'] || '');
        if (!/^\d{9,11}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) {
          log({ route: 'measure', status: 401, code: 'tijd' });
          return sendSigned(res, 401, { ok: false, code: 'niet_ondertekend', melding: 'Opdracht te oud of ongeldige tijd.' }, '');
        }
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
          log({ route: 'measure', status: 401, code: 'nonce' });
          return sendSigned(res, 401, { ok: false, code: 'niet_ondertekend', melding: 'Ongeldig opdrachtnummer.' }, '');
        }
        const body = await readBody(req, cfg.maxBody);
        if (!verify(clientKeys, message(REQ_PREFIX, ts, nonce, body), sig)) {
          log({ route: 'measure', status: 401, code: 'handtekening' });
          return sendSigned(res, 401, { ok: false, code: 'niet_ondertekend', melding: 'Handtekening klopt niet.' }, nonce);
        }
        if (nonces.seen(nonce)) {
          log({ route: 'measure', status: 409, code: 'herhaald' });
          return sendSigned(res, 409, { ok: false, code: 'herhaald', melding: 'Deze opdracht is al uitgevoerd.' }, nonce);
        }
        let job;
        try { job = JSON.parse(body.toString('utf8')); } catch { return sendSigned(res, 400, { ok: false, code: 'ongeldige_opdracht', melding: 'Geen geldige JSON.' }, nonce); }
        await acquire();
        let result;
        try {
          result = await runJob(job, { allowPrivate: cfg.allowPrivate, allowHttp: cfg.allowHttp, storeShot, trackerStub: cfg.trackerStub, volgWaitMs: cfg.volgWaitMs });
        } finally {
          release();
        }
        const hosts = [...new Set((job.pages || []).map((p) => { try { return new URL(p.url).hostname; } catch { return '?'; } }))];
        log({ route: 'measure', status: 200, hosts, metingen: result.metingen.length, ms: Date.now() - t0 });
        return sendSigned(res, 200, { ...result, versie: VERSION }, nonce);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Niet gevonden.');
    } catch (e) {
      const known = e instanceof JobError || e instanceof GuardError;
      const status = known ? (e.code === 'druk' ? 503 : 400) : 500;
      log({ route: path, status, code: e.code || 'fout', ms: Date.now() - t0, fout: known ? undefined : String(e.message).slice(0, 200) });
      if (!res.headersSent) {
        return sendSigned(res, status, { ok: false, code: e.code || 'fout', melding: known ? e.message : 'Er ging iets mis op de meetserver.' }, String(req.headers['x-wg-nonce'] || ''));
      }
      res.end();
    }
  });
}

export function configFromEnv(env = process.env) {
  const clientsFile = env.MEET_CLIENTS_FILE || fileURLToPath(new URL('../config/clients.json', import.meta.url));
  const clients = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '127.0.0.1',
    dataDir: env.MEET_DATA_DIR || '/var/lib/meet',
    clientKeys: (clients.keys || []).map((k) => k.key || k),
    publicBase: env.MEET_PUBLIC_BASE || 'https://meet.websitegesprek.nl',
    maxConcurrent: Number(env.MEET_MAX_CONCURRENT || 3),
    maxQueue: Number(env.MEET_MAX_QUEUE || 10),
    maxBody: 32 * 1024,
    shotTtlMs: 15 * 60 * 1000,
    maxShotBytes: 50 * 1024 * 1024,
    allowPrivate: env.MEET_TEST_ALLOW_PRIVATE === '1',
    allowHttp: env.MEET_TEST_ALLOW_PRIVATE === '1',
    // Teststand: volgdiensten nooit echt benaderen (kleine nabootsing in plaats van het echte script).
    trackerStub: env.MEET_TEST_ALLOW_PRIVATE === '1',
    volgWaitMs: env.MEET_TEST_ALLOW_PRIVATE === '1' && env.MEET_VOLG_WAIT_MS ? Number(env.MEET_VOLG_WAIT_MS) : undefined,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = configFromEnv();
  if (!cfg.clientKeys.length) console.warn('Let op: geen openbare sleutels van rapportage in config/clients.json; elke opdracht wordt geweigerd.');
  if (cfg.allowPrivate) console.warn('TESTSTAND: interne adressen en http toegestaan. Nooit in productie.');
  createServer(cfg).listen(cfg.port, cfg.host, () => console.log(`Meetserver ${VERSION} luistert op ${cfg.host}:${cfg.port}`));
}
