// Ondertekening met Ed25519 (node:crypto). Niemand hoeft een geheime sleutel over te typen:
// - rapportage tekent elke opdracht met zijn eigen geheime sleutel; de meetserver kent alleen de
//   openbare sleutel(s) van rapportage (config/clients.json, staat gewoon in GitHub);
// - de meetserver maakt bij de eerste start zijn eigen sleutelpaar in de datamap en tekent elk antwoord;
//   rapportage zet de openbare sleutel van de meetserver vast (GET /v1/pubkey).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REQ_PREFIX = 'wg-meet-opdracht:v1';
export const RESP_PREFIX = 'wg-meet-antwoord:v1';
export const MAX_SKEW_S = 60;

export function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function message(prefix, ts, nonce, body) {
  return Buffer.from(`${prefix}\n${ts}\n${nonce}\n${sha256hex(body)}`, 'utf8');
}

/** Ruwe 32-byte openbare sleutel (base64) naar een KeyObject. */
export function publicKeyFromRaw(b64) {
  const raw = Buffer.from(String(b64).trim(), 'base64');
  if (raw.length !== 32) throw new Error('Openbare sleutel moet 32 bytes zijn.');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function rawPublicKey(keyObj) {
  const der = keyObj.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export function sign(privateKey, msg) {
  return crypto.sign(null, msg, privateKey).toString('base64');
}

export function verify(publicKeys, msg, sigB64) {
  let sig;
  try {
    sig = Buffer.from(String(sigB64 || ''), 'base64');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return publicKeys.some((k) => {
    try {
      return crypto.verify(null, msg, k, sig);
    } catch {
      return false;
    }
  });
}

/** Laadt of maakt het sleutelpaar van de meetserver (alleen leesbaar voor de eigenaar). */
export function loadOrCreateServerKey(dir, pemFromEnv = process.env.MEET_SERVER_KEY_PEM) {
  // Op een dienst zonder vaste schijf (bijv. Google Cloud Run als reserve) komt de sleutel uit een geheime variabele.
  if (pemFromEnv) {
    const privateKey = crypto.createPrivateKey(pemFromEnv);
    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey, publicRaw: rawPublicKey(publicKey) };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'meet-ed25519.pem');
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, publicRaw: rawPublicKey(publicKey) };
}

/** Onthoudt gebruikte nonces 5 minuten, zodat een opdracht niet opnieuw kan worden afgespeeld. */
export class NonceCache {
  constructor(ttlMs = 5 * 60 * 1000, max = 20000) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  seen(nonce) {
    const now = Date.now();
    for (const [k, t] of this.map) {
      if (now - t > this.ttl) this.map.delete(k);
      else break;
    }
    if (this.map.has(nonce)) return true;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(nonce, now);
    return false;
  }
}
