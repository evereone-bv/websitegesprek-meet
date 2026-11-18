// Tests van de bewaking (meetserver 0.5.0, besluiten 481 en 506; voorwaarden WG - Review V1–V16, Juridisch BW1–BW3).
// Draaien: npm test. Alles lokaal op 127.0.0.1; de teststand staat interne adressen en http toe.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { hoortBij, stylesheets, meetSite, createBewaking, ophalen, VRAAG_PREFIX, LIJST_PREFIX, UITSLAG_PREFIX, UA } from '../src/bewaking.mjs';
import { message, sign, verify, rawPublicKey, loadOrCreateServerKey } from '../src/keys.mjs';
import { createServer } from '../src/server.mjs';

const luister = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const poort = (s) => s.address().port;
const cfgTest = (extra = {}) => ({ allowPrivate: true, allowHttp: true, schemaVoorTest: 'http', timeoutMs: 1500, siteBudgetMs: 4000, ...extra });

// Klantsite-nabootsing: /, stylesheets, inlogpagina. Gedrag per pad instelbaar.
const gezien = [];
const stand = { css404: false, login500: false, homeStatus: 200, traagMs: 0, groot: false };
let klant;
test.before(async () => {
  klant = await luister((req, res) => {
    gezien.push({ url: req.url, ua: req.headers['user-agent'], cookie: req.headers.cookie || '', method: req.method });
    if (req.url === '/') {
      const p = poort(klant);
      const body = stand.groot ? 'x'.repeat(3 * 1024 * 1024)
        : `<html><head><link rel='stylesheet' href='/wp-content/uploads/elementor/css/post-8.css?ver=1' media='all'>
           <link rel="stylesheet" href="http://127.0.0.1:${p}/thema.css"><link rel="stylesheet" href="http://169.254.169.254/latest/meta-data.css">
           <link rel="stylesheet" href="http://127.0.0.2:${p}/intern.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=x"></head><body>Hallo</body></html>`;
      setTimeout(() => { res.writeHead(stand.homeStatus, { 'Content-Type': 'text/html' }); res.end(body); }, stand.traagMs);
      return;
    }
    if (req.url.startsWith('/wp-content/uploads/elementor/css/post-8.css')) { res.writeHead(stand.css404 ? 404 : 200, { 'Content-Type': 'text/css' }); return res.end('body{}'); }
    if (req.url === '/thema.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('p{}'); }
    if (req.url === '/wp-login.php') { res.writeHead(stand.login500 ? 500 : 404); return res.end('login'); }
    if (req.url === '/doorsturen') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
    res.writeHead(404); res.end();
  });
});
test.after(() => klant.close());
const site = () => `127.0.0.1:${poort(klant)}`;

test('hoortBij: zelfde host, het domein zonder www en subdomeinen; geen andere domeinen', () => {
  assert.ok(hoortBij('www.voorbeeld.nl', 'voorbeeld.nl'));
  assert.ok(hoortBij('voorbeeld.nl', 'cdn.voorbeeld.nl'));
  assert.ok(!hoortBij('voorbeeld.nl', 'voorbeeld.nl.evil.com'));
  assert.ok(!hoortBij('voorbeeld.nl', '169.254.169.254'));
});

test('stylesheets: Elementor-opmaak eerst, hooguit 3, alleen van de eigen site (keuzeregel B5, V3)', () => {
  const html = `<link rel="stylesheet" href="https://voorbeeld.nl/a.css"><link rel='stylesheet' href='https://voorbeeld.nl/wp-content/uploads/elementor/css/post-8.css'>
    <link rel="stylesheet" href="http://127.0.0.1/x.css"><link rel="stylesheet" href="https://andere.nl/b.css"><link rel="preload" href="https://voorbeeld.nl/c.css">
    <link rel="stylesheet" href="/d.css"><link rel="stylesheet" href="/e.css">`;
  const l = stylesheets(html, 'https://voorbeeld.nl/', 'voorbeeld.nl');
  assert.equal(l.length, 3);
  assert.match(l[0], /elementor\/css\/post-8\.css/);
  assert.ok(l.every((u) => new URL(u).hostname === 'voorbeeld.nl'));
});

test('meetSite: ok, met user-agent die ons noemt, zonder cookies, alleen GET (BW1, BW3)', async () => {
  gezien.length = 0;
  const r = await meetSite(site(), cfgTest());
  assert.equal(r.uitkomst, 'ok');
  assert.equal(r.opmaak, true);
  assert.deepEqual(Object.keys(r).sort(), ['code', 'ms', 'opmaak', 'site', 'tijd', 'uitkomst']); // BW2
  assert.ok(gezien.every((g) => g.ua === UA && g.cookie === '' && g.method === 'GET'));
});

test('V3: stylesheets naar 127.0.0.2 (ander adres) en 169.254.169.254 worden niet opgevraagd', async () => {
  gezien.length = 0;
  await meetSite(site(), cfgTest());
  assert.ok(!gezien.some((g) => /intern\.css|meta-data/.test(g.url)));
});

test('opmaak_weg: Elementor-stylesheet geeft 404 (de storing van Tamara)', async () => {
  stand.css404 = true;
  const r = await meetSite(site(), cfgTest());
  stand.css404 = false;
  assert.equal(r.uitkomst, 'opmaak_weg');
  assert.equal(r.opmaak, false);
});

test('fout: homepage 500; inlogpagina 500; inlogpagina 404 (verborgen inlogadres) is geen fout', async () => {
  stand.homeStatus = 500;
  assert.equal((await meetSite(site(), cfgTest())).uitkomst, 'fout');
  stand.homeStatus = 200;
  stand.login500 = true;
  assert.equal((await meetSite(site(), cfgTest())).uitkomst, 'fout');
  stand.login500 = false;
  assert.equal((await meetSite(site(), cfgTest())).uitkomst, 'ok');
});

test('geblokkeerd: 403 of 429 van een botcontrole geeft geen fout', async () => {
  stand.homeStatus = 403;
  assert.equal((await meetSite(site(), cfgTest())).uitkomst, 'geblokkeerd');
  stand.homeStatus = 200;
});

test('V4: tijdslimiet per verzoek; een hangende site wordt fout of niet_gemeten, nooit langer dan het budget', async () => {
  stand.traagMs = 3000;
  const t0 = Date.now();
  const r = await meetSite(site(), cfgTest({ timeoutMs: 300, siteBudgetMs: 800 }));
  stand.traagMs = 0;
  assert.ok(Date.now() - t0 < 1500, `duurde ${Date.now() - t0} ms`);
  assert.ok(['fout', 'niet_gemeten'].includes(r.uitkomst));
});

test('V5: een antwoord wordt na 2 MB afgebroken', async () => {
  const r = await ophalen(`http://${site()}/`, '127.0.0.1', { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 });
  assert.ok(r.body.length <= 2 * 1024 * 1024);
  stand.groot = true;
  const g = await ophalen(`http://${site()}/`, '127.0.0.1', { maxBytes: 2 * 1024 * 1024, timeoutMs: 5000 });
  stand.groot = false;
  assert.ok(g.afgekapt && g.body.length === 2 * 1024 * 1024);
});

test('V3: een doorverwijzing naar 169.254.169.254 wordt niet gevolgd', async () => {
  gezien.length = 0;
  const { volgen } = await import('../src/bewaking.mjs');
  const r = await volgen(`http://${site()}/doorsturen`, site(), cfgTest(), { maxBytes: 1024, deadline: Date.now() + 2000 });
  assert.equal(r.fout, 'ander_domein');
});

// ---------- Rapportage nagebootst: ondertekende lijst en uitslag (V1, V2, V14) ----------
function rapportageNabootsing({ sites, sleutel, meetPub, knoei = false }) {
  const ontvangen = [];
  const gebruikt = new Set();
  const s = http.createServer((req, res) => {
    const delen = [];
    req.on('data', (c) => delen.push(c));
    req.on('end', () => {
      const body = Buffer.concat(delen);
      const ts = String(req.headers['x-wg-ts'] || '');
      const nonce = String(req.headers['x-wg-nonce'] || '');
      const prefix = req.url.endsWith('bewaking-lijst') ? VRAAG_PREFIX : UITSLAG_PREFIX;
      const ok = Math.abs(Date.now() / 1000 - Number(ts)) <= 60 && !gebruikt.has(nonce) && verify([meetPub()], message(prefix, ts, nonce, body), String(req.headers['x-wg-signature'] || ''));
      gebruikt.add(nonce);
      if (!ok) { res.writeHead(401); return res.end('{}'); }
      if (req.url.endsWith('bewaking-lijst')) {
        const out = Buffer.from(JSON.stringify({ sites: sites() }));
        const rts = String(Math.floor(Date.now() / 1000));
        const sig = sign(sleutel.privateKey, message(LIJST_PREFIX, rts, nonce, knoei ? Buffer.from('anders') : out));
        res.writeHead(200, { 'X-WG-Ts': rts, 'X-WG-Nonce': nonce, 'X-WG-Signature': sig, 'Content-Type': 'application/json' });
        return res.end(out);
      }
      ontvangen.push(JSON.parse(body.toString('utf8')));
      res.writeHead(200); res.end('{"ok":true}');
    });
  });
  return { s, ontvangen };
}

test('ronde: ondertekende lijst ophalen, meten en ondertekende uitslag sturen (V1, V2); niets zonder BEWAKING_AAN (V14)', async () => {
  const rap = crypto.generateKeyPairSync('ed25519');
  const meet = crypto.generateKeyPairSync('ed25519');
  const { s, ontvangen } = rapportageNabootsing({ sites: () => [site()], sleutel: rap, meetPub: () => meet.publicKey });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const basis = { rapportage: `http://127.0.0.1:${poort(s)}`, eigen: [], serverKey: { privateKey: meet.privateKey }, clientKeys: [rap.publicKey], ...cfgTest(), rondeBudgetMs: 10000, tegelijk: 5 };
  const uit = createBewaking({ ...basis, aan: false });
  assert.equal(await uit.ronde(), null);
  assert.equal(uit.start(), false);
  assert.equal(ontvangen.length, 0);
  const b = createBewaking({ ...basis, aan: true });
  const r = await b.ronde();
  assert.ok(r && r.ronde && r.uitslagen.length === 1 && r.uitslagen[0].uitkomst === 'ok');
  assert.equal(ontvangen.length, 1);
  assert.equal(ontvangen[0].ronde, r.ronde);
  s.close();
});

test('V1: een lijst met een handtekening die niet klopt, wordt genegeerd', async () => {
  const rap = crypto.generateKeyPairSync('ed25519');
  const meet = crypto.generateKeyPairSync('ed25519');
  const { s, ontvangen } = rapportageNabootsing({ sites: () => [site()], sleutel: rap, meetPub: () => meet.publicKey, knoei: true });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const b = createBewaking({ aan: true, rapportage: `http://127.0.0.1:${poort(s)}`, eigen: [], serverKey: { privateKey: meet.privateKey }, clientKeys: [rap.publicKey], ...cfgTest(), rondeBudgetMs: 5000, tegelijk: 5 });
  assert.equal(await b.ronde(), null);
  assert.equal(ontvangen.length, 0);
  s.close();
});

test('V4: 1.000 sites die allemaal hangen: de ronde stopt op het budget, de rest is niet_gemeten, nooit twee rondes tegelijk', async () => {
  const hangt = await luister(() => {}); // antwoordt nooit
  const rap = crypto.generateKeyPairSync('ed25519');
  const meet = crypto.generateKeyPairSync('ed25519');
  const sites = Array.from({ length: 1000 }, () => `127.0.0.1:${poort(hangt)}`);
  const { s, ontvangen } = rapportageNabootsing({ sites: () => sites, sleutel: rap, meetPub: () => meet.publicKey });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const b = createBewaking({ aan: true, rapportage: `http://127.0.0.1:${poort(s)}`, eigen: [], serverKey: { privateKey: meet.privateKey }, clientKeys: [rap.publicKey], ...cfgTest(), timeoutMs: 200, siteBudgetMs: 600, rondeBudgetMs: 2000, tegelijk: 20 });
  const t0 = Date.now();
  const eerste = b.ronde();
  assert.equal(await b.ronde(), null, 'tweede ronde start niet terwijl de eerste loopt');
  const r = await eerste;
  const duur = Date.now() - t0;
  assert.ok(duur < 2000 + 1500, `ronde duurde ${duur} ms`);
  assert.ok(r.te_traag && r.uitslagen.length === 1000);
  assert.ok(r.uitslagen.filter((u) => u.uitkomst === 'niet_gemeten').length > 0);
  assert.equal(ontvangen.length, 1);
  s.close(); hangt.close();
});

test('V16: een lopende bewakingsronde laat de meetserver niet wachten (healthz, geen meetplaats bezet)', async () => {
  const hangt = await luister(() => {});
  const rap = crypto.generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bewaking-'));
  const sites = Array.from({ length: 50 }, () => `127.0.0.1:${poort(hangt)}`);
  const meetSleutel = { pub: null };
  const { s } = rapportageNabootsing({ sites: () => sites, sleutel: rap, meetPub: () => meetSleutel.pub });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const srv = createServer({ clientKeys: [rawPublicKey(rap.publicKey)], dataDir: dir, publicBase: 'http://x', maxConcurrent: 3, maxQueue: 10, maxBody: 32768, shotTtlMs: 1000, maxShotBytes: 1e6, allowPrivate: true, allowHttp: true, quiet: true,
    bewaking: { aan: true, rapportage: `http://127.0.0.1:${poort(s)}`, eigen: [], ...cfgTest(), timeoutMs: 1000, siteBudgetMs: 2000, rondeBudgetMs: 3000, tegelijk: 20 } });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  meetSleutel.pub = loadOrCreateServerKey(dir).publicKey;
  const loopt = srv.bewaking.ronde();
  await new Promise((ok) => setTimeout(ok, 300));
  const t0 = Date.now();
  const h = await ophalen(`http://127.0.0.1:${poort(srv)}/healthz`, '127.0.0.1', { timeoutMs: 1000 });
  const d = JSON.parse(h.body.toString('utf8'));
  assert.equal(h.status, 200);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(d.bezig, 0, 'geen meetplaats bezet door de bewaking');
  await loopt;
  srv.close(); s.close(); hangt.close();
});

test('506: eigen server twee keer achter elkaar weg: één alarmmail; weer bereikbaar: herstelmail', async () => {
  const st = { ok: false };
  const eigen = await luister((req, res) => { res.writeHead(st.ok ? 200 : 503); res.end('{}'); });
  const mails = [];
  const b = createBewaking({ aan: true, rapportage: 'http://127.0.0.1:1', eigen: [`http://127.0.0.1:${poort(eigen)}/wp-json/`], serverKey: { privateKey: crypto.generateKeyPairSync('ed25519').privateKey }, clientKeys: [], ...cfgTest(), timeoutMs: 500, rondeBudgetMs: 1000, tegelijk: 1, mailer: async (o) => { mails.push(o); } });
  await b.ronde();
  assert.equal(mails.length, 0, 'eerste fout: nog geen mail');
  await b.ronde();
  await b.ronde();
  assert.equal(mails.length, 1);
  assert.match(mails[0], /^🔴 ALARM Websitegesprek/);
  st.ok = true;
  await b.ronde();
  assert.equal(mails.length, 2);
  assert.match(mails[1], /^🟢 Hersteld Websitegesprek/);
  eigen.close();
});
