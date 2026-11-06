// Tests van de meetserver: adresbewaking, ondertekening, en echte metingen met Chromium op testpagina's
// die de gevallen van Puglia (6 nov 2026) nabootsen. Draaien: npm test (of node --test test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPublicIp, checkUrl, resolvePublic } from '../src/guard.mjs';
import { REQ_PREFIX, RESP_PREFIX, message, sign, verify, publicKeyFromRaw, rawPublicKey } from '../src/keys.mjs';
import { createServer } from '../src/server.mjs';

// ---------- testpagina's ----------
const BTN = 'background:#9e583f;color:#fff;border-radius:8px;padding:24px 29px;font:18px/18px sans-serif;text-decoration:none';
const STD = `<div class="wp-block-button" style="margin:40px"><a class="wp-block-button__link" style="display:inline-block;${BTN}" href="#x">Brochure</a></div>`;
const block = (inline, pad = 48) => `<div class="ph-contact" style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:${pad}px 32px;background:#f2f0ec;border-radius:8px;text-align:center;margin:40px 16px">
  <h2 style="margin:0;font:400 28px/1.2 serif">Interesse in dit huis?</h2>
  <p style="margin:0;font:18px/1.6 sans-serif">Neem contact met ons op voor meer informatie of om een bezichtiging te plannen.</p>
  <div class="wp-block-buttons" style="margin-top:8px"><div class="wp-block-button"><a class="wp-block-button__link" style="${inline ? '' : 'display:inline-block;'}${BTN}" href="#contact">Neem contact op</a></div></div>
</div>`;
const html = (body, extraHead = '') => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<style>body{margin:0;font-family:sans-serif}</style></head><body>${body}</body></html>`;
const pages = {
  '/contact-fout': html(STD + block(true)),
  '/contact-goed': html(STD + block(false)),
  '/en/contact-goed': html(STD + block(false, 40)),
  '/breed': html('<div class="breed" style="width:600px;height:50px;background:#eee">breed</div>'),
  '/contrast': html('<p class="licht" style="color:#cccccc;background:#fff;font-size:16px">Lichtgrijze tekst</p>'),
  '/menu': html(`<header><button class="wp-block-navigation__responsive-container-open" style="width:48px;height:48px" onclick="document.getElementById('m').style.display='block'">Menu</button></header>
     <nav id="m" class="menu-open" style="display:none;padding:20px"><a href="#a">Home</a></nav>`),
  '/taalkeuze': html(`<style>.lang{position:relative;width:68px;height:48px;margin:20px}.lang ul{position:absolute;top:0;left:0;right:0;margin:0;padding:2px;list-style:none;background:#fff}.lang li{display:none;height:44px}.lang li.cur,.lang:focus-within li{display:block}</style>
     <nav class="lang"><ul><li class="cur"><span tabindex="0" class="cur-btn">NL</span></li><li><a href="#en">EN</a></li></ul></nav>`),
  '/link': html('<a id="weg" href="/elders" style="display:inline-block;padding:20px">Naar elders</a>'),
  '/post-bij-laden': html('<p class="x">Hallo</p><script>fetch("/track",{method:"POST",body:"x"}).catch(()=>{})</script>'),
  '/elders': html('<p>Elders</p>'),
};
let fixtureHits = [];
function startFixture() {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    fixtureHits.push(`${req.method} ${p}`);
    if (p === '/naar-buiten') { res.writeHead(302, { Location: 'http://voorbeeld.invalid/' }); return res.end(); }
    if (p === '/fout') { res.writeHead(500); return res.end('kapot'); }
    if (pages[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(pages[p]); }
    res.writeHead(404); res.end('nee');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ---------- hulpfuncties ----------
const client = crypto.generateKeyPairSync('ed25519');
const otherClient = crypto.generateKeyPairSync('ed25519');
function startMeet(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'));
  const cfg = { port: 0, host: '127.0.0.1', dataDir, clientKeys: [rawPublicKey(client.publicKey)], publicBase: 'http://meet.test', maxConcurrent: 2, maxQueue: 2, maxBody: 32 * 1024, shotTtlMs: 60000, maxShotBytes: 10 * 1024 * 1024, allowPrivate: true, allowHttp: true, quiet: true, ...overrides };
  const srv = createServer(cfg);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function call(meet, job, { key = client.privateKey, ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(12).toString('base64url'), sig } = {}) {
  const body = Buffer.from(JSON.stringify(job));
  const signature = sig ?? sign(key, message(REQ_PREFIX, String(ts), nonce, body));
  const res = await fetch(`http://127.0.0.1:${meet.address().port}/v1/measure`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-WG-Ts': String(ts), 'X-WG-Nonce': nonce, 'X-WG-Signature': signature } });
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, json: JSON.parse(raw.toString()), raw, headers: res.headers, nonce };
}
const codes = (m) => (m.meldingen || []).map((f) => f.code);

let fixture, meet, base;
test.before(async () => {
  fixture = await startFixture();
  meet = await startMeet();
  base = `http://localhost:${fixture.address().port}`;
});
test.after(() => { fixture.close(); meet.close(); });

// ---------- adresbewaking ----------
test('interne en bijzondere IP-adressen zijn niet openbaar', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['185.12.64.1', '8.8.8.8', '2a01:4f8::1', '35.214.171.161']) assert.equal(isPublicIp(ip), true, ip);
});
test('alleen https op het eigen domein, geen IP-adressen of inloggegevens', () => {
  assert.throws(() => checkUrl('http://site.nl/', ['site.nl']), { code: 'geen_https' });
  assert.throws(() => checkUrl('https://ander.nl/', ['site.nl']), { code: 'ander_domein' });
  assert.throws(() => checkUrl('https://169.254.169.254/', ['169.254.169.254']), { code: 'ongeldig_adres' });
  assert.throws(() => checkUrl('https://user:pw@site.nl/', ['site.nl']), { code: 'ongeldig_adres' });
  assert.throws(() => checkUrl('https://site.nl:8443/', ['site.nl']), { code: 'ongeldig_adres' });
  assert.throws(() => checkUrl('javascript:alert(1)', ['site.nl']), { code: 'geen_https' });
  assert.equal(checkUrl('https://Site.NL/pagina#x', ['site.nl']).url, 'https://site.nl/pagina');
});
test('domein dat naar een intern adres wijst wordt geweigerd', async () => {
  await assert.rejects(resolvePublic('localhost'), { code: 'intern_adres' });
});

// ---------- ondertekening ----------
test('zonder geldige handtekening, met oude tijd of opnieuw afgespeeld: geweigerd', async () => {
  const job = { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-goed` }], widths: [390] };
  assert.equal((await call(meet, job, { sig: 'AAAA' })).status, 401, 'kapotte handtekening');
  assert.equal((await call(meet, job, { key: otherClient.privateKey })).status, 401, 'onbekende sleutel');
  assert.equal((await call(meet, job, { ts: Math.floor(Date.now() / 1000) - 300 })).status, 401, 'te oud');
  const first = await call(meet, { ...job, shot: false });
  assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 300));
  const again = await call(meet, { ...job, shot: false }, { nonce: first.nonce });
  assert.equal(again.status, 409, 'herhaald');
});
test('antwoord is ondertekend door de meetserver (openbare sleutel via /v1/pubkey)', async () => {
  const pk = await (await fetch(`http://127.0.0.1:${meet.address().port}/v1/pubkey`)).json();
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-goed` }], widths: [390], shot: false });
  assert.equal(r.status, 200);
  const ok = verify([publicKeyFromRaw(pk.key)], message(RESP_PREFIX, r.headers.get('x-wg-ts'), r.nonce, r.raw), r.headers.get('x-wg-signature'));
  assert.ok(ok, 'handtekening antwoord klopt');
  assert.equal(r.headers.get('x-wg-nonce'), r.nonce);
});

// ---------- metingen (gevallen Puglia) ----------
test('Puglia-geval: knop als tekst (inline) met binnenruimte wordt gemeld, met oplossing', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-fout` }], widths: [390], selectors: ['.ph-contact'], shot: false });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const m = r.json.metingen[0];
  assert.ok(codes(m).includes('inline_met_binnenruimte'), JSON.stringify(m.meldingen));
  assert.match(m.meldingen.find((f) => f.code === 'inline_met_binnenruimte').melding, /inline-block/);
});
test('goed contactblok: boven en onder gelijk, knop zo hoog als de standaardknop, geen meldingen over het blok', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-goed` }], widths: [390, 1440], selectors: ['.ph-contact'], shot: true });
  assert.equal(r.status, 200);
  for (const m of r.json.metingen) {
    const b = m.blokken[0];
    assert.ok(b.gevonden);
    assert.ok(Math.abs(b.ruimte.boven - b.ruimte.onder) <= 1, JSON.stringify(b.ruimte));
    assert.equal(b.ruimte.boven, 48);
    assert.deepEqual(codes(m).filter((c) => ['inline_met_binnenruimte', 'binnenruimte_ongelijk', 'overloop', 'knop_hoogte_afwijkend'].includes(c)), [], JSON.stringify(m.meldingen));
    assert.equal(b.knoppen[0].h, m.standaardknop.h);
    assert.match(m.plaatje, /^http:\/\/meet\.test\/v1\/plaatje\/[A-Za-z0-9_-]{24}\.jpg$/);
  }
  assert.equal(r.json.metingen[0].breedte, 390);
  assert.equal(r.json.metingen[1].breedte, 1440);
});
test('plaatje is op te halen en verloopt (onbekend teken geeft 404)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-goed` }], widths: [390], selectors: ['.ph-contact'] });
  const token = r.json.metingen[0].plaatje.split('/').pop();
  const img = await fetch(`http://127.0.0.1:${meet.address().port}/v1/plaatje/${token}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok((await img.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`http://127.0.0.1:${meet.address().port}/v1/plaatje/${'a'.repeat(24)}.jpg`)).status, 404);
});
test('verschil tussen talen wordt gemeld (Engelse versie andere binnenruimte)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/contact-goed`, label: 'nl' }, { url: `${base}/en/contact-goed`, label: 'en' }], widths: [390], selectors: ['.ph-contact'], shot: false });
  assert.ok(r.json.vergelijking.some((v) => v.code === 'verschil_tussen_talen' && /boven/.test(v.melding)), JSON.stringify(r.json.vergelijking));
});
test('horizontaal scrollen op mobiel en te weinig contrast worden gemeld', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/breed` }, { url: `${base}/contrast` }], widths: [390], selectors: ['.licht'], shot: false });
  assert.ok(codes(r.json.metingen[0]).includes('horizontaal_scrollen'));
  assert.ok(codes(r.json.metingen[1]).includes('contrast_laag'), JSON.stringify(r.json.metingen[1].meldingen));
});
test('menu openen werkt, en daarna is het menu zichtbaar en meetbaar', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/menu` }], widths: [390], actions: [{ type: 'menu' }], selectors: ['.menu-open'], shot: false });
  const m = r.json.metingen[0];
  assert.equal(m.acties[0].gedaan, true);
  assert.equal(m.blokken[0].gevonden, true);
});

test('geopend uitklapmenu (taalkeuze) telt niet als overloop', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/taalkeuze` }], widths: [390], actions: [{ type: 'focus', selector: '.cur-btn' }], selectors: ['.lang'], shot: false });
  const m = r.json.metingen[0];
  assert.equal(m.acties[0].gedaan, true);
  assert.ok(!codes(m).includes('overloop'), JSON.stringify(m.meldingen));
});

// ---------- alleen kijken ----------
test('alleen kijken: link aanklikken mag niet, POST bij laden wordt tegengehouden', async () => {
  fixtureHits = [];
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/link` }, { url: `${base}/post-bij-laden` }], widths: [390], actions: [{ type: 'click', selector: '#weg' }], shot: false });
  assert.equal(r.json.metingen[0].acties[0].gedaan, false);
  assert.ok(!fixtureHits.some((h) => h.startsWith('GET /elders')), 'niet naar elders genavigeerd');
  assert.ok(!fixtureHits.some((h) => h.startsWith('POST')), 'geen POST bij de site');
  assert.ok((r.json.metingen[1].tegengehouden || []).some((t) => t.startsWith('POST')));
});
test('doorverwijzing naar een ander domein wordt afgebroken', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/naar-buiten` }], widths: [390], shot: false });
  const m = r.json.metingen[0];
  assert.ok(m.fout, 'meting mislukt');
  assert.ok((m.tegengehouden || []).some((t) => t.includes('voorbeeld.invalid')), JSON.stringify(m));
});
test('adres buiten de toegestane domeinen of te veel metingen: geweigerd met duidelijke melding', async () => {
  const a = await call(meet, { allowed_hosts: ['site.nl'], pages: [{ url: `${base}/contact-goed` }] });
  assert.equal(a.status, 400);
  assert.equal(a.json.code, 'ander_domein');
  const b = await call(meet, { allowed_hosts: ['localhost'], pages: [1, 2, 3, 4, 5].map(() => ({ url: `${base}/contact-goed` })) });
  assert.equal(b.status, 400);
  assert.equal(b.json.code, 'ongeldige_opdracht');
});
test('in productiestand (geen teststand) wordt een intern adres altijd geweigerd', async () => {
  const prod = await startMeet({ allowPrivate: false, allowHttp: false });
  try {
    const r = await call(prod, { allowed_hosts: ['localhost'], pages: [{ url: 'https://localhost/' }], widths: [390] });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'intern_adres');
  } finally {
    prod.close();
  }
});
test('statusfout van de site wordt netjes gemeld', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/fout` }], widths: [390], shot: false });
  assert.equal(r.json.metingen[0].status, 500);
  assert.match(r.json.metingen[0].fout, /status 500/);
});
