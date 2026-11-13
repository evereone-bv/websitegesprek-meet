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
import { volgDienst, volgCookie } from '../src/measure.mjs';

// ---------- testpagina's ----------
const BTN = 'background:#9e583f;color:#fff;border-radius:8px;padding:24px 29px;font:18px/18px sans-serif;text-decoration:none';
const STD = `<div class="wp-block-button" style="margin:40px"><a class="wp-block-button__link" style="display:inline-block;${BTN}" href="#x">Brochure</a></div>`;
const block = (inline, pad = 48) => `<div class="ph-contact" style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:${pad}px 32px;background:#f2f0ec;border-radius:8px;text-align:center;margin:40px 16px">
  <h2 style="margin:0;font:400 28px/1.2 serif">Interesse in dit huis?</h2>
  <p style="margin:0;font:18px/1.6 sans-serif">Neem contact met ons op voor meer informatie of om een bezichtiging te plannen.</p>
  <div class="wp-block-buttons" style="margin-top:8px"><div class="wp-block-button"><a class="wp-block-button__link" style="${inline ? '' : 'display:inline-block;'}${BTN}" href="#contact">Neem contact op</a></div></div>
</div>`;
const PIXEL_BODY = "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.queue.push(arguments)};n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','1234567890');fbq('track','PageView');";
const PIXEL = `<script>${PIXEL_BODY}</script>`;
const html = (body, extraHead = '') => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<style>body{margin:0;font-family:sans-serif}</style></head><body>${body}</body></html>`;
const pages = {
  // Sinds 0.4.2 (besluit 369): ankers op de kop, en een vaste kop die de sectiekop na springen bedekt.
  '/ankers': html(`<header style="position:sticky;top:0;height:80px;background:#fff;width:100%">Kop</header>
     <nav><a href="#goed">Goed</a> <a href="#tekst">Tekst</a> <a href="#sectie">Sectie</a> <a href="#marge">Marge</a></nav>
     <h2 id="goed">Goede kop</h2><p style="height:800px">x</p>
     <h2>Kop boven tekst</h2><p id="tekst" style="height:800px">anker op de tekst</p>
     <section id="sectie" style="scroll-margin-top:80px"><h2>Sectie met kop</h2><p style="height:800px">y</p></section>
     <h2 id="marge" style="scroll-margin-top:96px">Kop met marge</h2><p style="height:800px">z</p>`),
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
  // Sinds 0.2.0: logo in de header (icoon naast tekst, flex-rij) is geen overlap; echte overlap wel.
  '/logo-rij': html(`<header><a class="logo" href="#" style="display:flex;align-items:center;gap:10px;padding:12px;width:260px"><svg width="40" height="40"><circle cx="20" cy="20" r="18"/></svg><span style="font:700 22px/1 sans-serif">Websitegesprek</span></a>
     <a class="wp-block-button__link" style="display:inline-block;padding:6px 10px;font:14px/1 sans-serif" href="#k">Klein</a></header>
     <div class="echt" style="position:relative;height:120px"><div style="height:60px;background:#ccc">A</div><div style="height:60px;margin-top:-30px;margin-left:20px;background:#999">B</div></div>
     <main><a class="wp-block-button__link" style="display:inline-block;padding:16px 24px;font:16px/1 sans-serif" href="#1">Een</a>
     <a class="wp-block-button__link" style="display:inline-block;padding:16px 24px;font:16px/1 sans-serif" href="#2">Twee</a></main>`),
  // Sinds 0.2.0: vet dat niet opvalt (zelfde grijs, of niet vetter) of onzichtbaar is op een donker vlak.
  '/nadruk': html(`<div class="grijs"><p style="color:#6b7280">Tekst met <strong>nadruk</strong> in grijs.</p></div>
     <div class="donker" style="background:#0e1b2c;padding:10px"><p style="color:#f6f4ee">Licht op donker met <strong style="color:#0e1b2c">onzichtbare nadruk</strong>.</p></div>
     <div class="goed"><p style="color:#6b7280">Grijze tekst met <strong style="color:#111">donkere nadruk</strong>.</p><p style="color:#222">Donkere tekst met <b>gewone nadruk</b>.</p></div>`),
  '/knop-twee-regels': html(`<div class="smal" style="width:120px"><a class="wp-block-button__link" style="display:inline-block;padding:0 12px;background:#9e583f;color:#fff;font:16px/1.2 sans-serif" href="#x">Neem nu contact met ons op</a></div>
     <div class="ruim" style="width:120px"><a class="wp-block-button__link" style="display:inline-block;padding:12px;background:#9e583f;color:#fff;font:16px/1.2 sans-serif" href="#y">Neem nu contact met ons op</a></div>`),
  // Sinds 0.3.0: volgcodes vóór akkoord (besluit 53). Echte volgdiensten worden in de teststand nagebootst.
  '/volg-direct': html('<p>Pixel direct</p>', PIXEL),
  '/volg-eigen-melding': html(`<div id="wg-cookie" class="wg-cookiebalk" style="position:fixed;bottom:0;left:0;right:0;padding:16px;background:#fff">
     <p>Wij gebruiken cookies voor statistieken en advertenties.</p><button id="wg-akkoord" type="button">Akkoord</button> <button type="button">Weigeren</button></div>
     <script>function wgStartPixel(){${PIXEL_BODY}} if(document.cookie.indexOf('wg_akkoord=1')>-1){wgStartPixel();}
     document.getElementById('wg-akkoord').addEventListener('click',function(){document.cookie='wg_akkoord=1;path=/';wgStartPixel();});</script>`),
  '/volg-consentmode': html('<p>Consent Mode</p>', `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});</script>
     <script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script><script>gtag('js',new Date());gtag('config','G-TEST123');</script>`),
  '/volg-textplain': html('<p>Tegengehouden</p>', PIXEL.replace('<script>', '<script type="text/plain" data-category="marketing">')),
  '/volg-gtm-na-akkoord': html(`<div class="cookie-consent"><span>Cookies?</span><a href="#" role="button" id="ok">Accepteer alle cookies</a></div>
     <script>document.getElementById('ok').addEventListener('click',function(e){e.preventDefault();(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;d.head.appendChild(j);})(window,document,'script','dataLayer','GTM-AB12CD');});</script>`),
  '/volg-later': html('<p>Na 1,5 seconde</p><script>setTimeout(function(){var s=document.createElement("script");s.src="https://www.clarity.ms/tag/abc";document.head.appendChild(s);},1500);</script>'),
  // Sinds 0.4.0 (besluit 177 en 181): lettergrootte per rol en iconen in rondjes.
  '/lettergroottes': html(`<main><h2 style="font-size:32px">Een</h2><h2 style="font-size:28px">Twee</h2><p style="font-size:18px">Tekst een.</p><p style="font-size:18px">Tekst twee.</p><p style="font-size:16px">Klein een.</p><p style="font-size:16px">Klein twee.</p><p style="font-size:18px">Tekst drie.</p></main>`),
  '/lettergroottes-goed': html(`<main><h2 style="font-size:32px">Een</h2><h2 style="font-size:32px">Twee</h2><p style="font-size:18px">Tekst een.</p><p style="font-size:18px">Tekst twee.</p></main>`),
  '/iconen': html(`<style>.r{width:40px;height:40px;border-radius:50%;background:#0e1b2c;color:#fff;display:inline-flex;align-items:center;justify-content:center;margin:10px;font:24px/1 sans-serif}
     .p{position:relative}.p::before{content:"";position:absolute;left:12px;top:19px;width:16px;height:2px;background:#fff}
     .s{position:relative;display:inline-block;width:40px;height:40px;border-radius:50%;background:#0e1b2c;margin:10px}.s span{position:absolute;left:20px;top:12px;width:16px;height:16px;background:#fff}
     .k::after{content:"+"}</style>
     <span class="r teken">+</span><span class="r k pseudo"></span><span class="r p goed"></span><span class="s scheef"><span></span></span>
     <span class="s recht"><span style="left:12px;top:12px"></span></span>`),
  // Sinds 0.4.1 (besluit 175): korte pagina met strook, 404-pagina, dichtgeklapte vragen.
  '/kort': html(`<main style="margin:0"><h1 style="margin:0">Kort</h1></main><footer style="background:#0e1b2c;color:#fff;height:120px">Footer</footer>`),
  '/faq': html(`<section class="faq" style="padding:24px"><details><summary style="height:40px">Vraag een</summary><p style="height:600px">Antwoord dat lang is.</p></details><details><summary style="height:40px">Vraag twee</summary><p>Antwoord.</p></details></section>`),
  '/knoppen': html(`<details class="v"><summary class="s">Open mij</summary><p>Binnen</p></details>`),
  '/voor-na': html(`<h1 style="margin:20px">Welkom</h1><p class="tekst" style="margin:20px">Gewone tekst.</p>
     <form style="margin:20px;height:80px;background:#eee"><input name="q" value="${'x'.repeat(5)}"></form>`),
};
let fixtureHits = [];
function startFixture() {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    fixtureHits.push(`${req.method} ${p}`);
    if (p === '/naar-buiten') { res.writeHead(302, { Location: 'http://voorbeeld.invalid/' }); return res.end(); }
    if (p === '/concept') {
      const ok = req.headers['x-wg-meet'] === 'T'.repeat(43);
      fixtureHits.push(`concept ${ok ? 'met' : 'zonder'} token ${req.url.includes('T'.repeat(10)) ? 'in adres' : ''}`);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(ok ? html(`<h1>Concept</h1><img src="/plaatje.png" width="10" height="10"><img src="http://andere.invalid/volg.png" width="1" height="1">`) : 'nee');
    }
    if (p === '/plaatje.png') { fixtureHits.push(`plaatje ${req.headers['x-wg-meet'] ? 'met' : 'zonder'} token`); res.writeHead(404); return res.end(); }
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
  const cfg = { port: 0, host: '127.0.0.1', dataDir, clientKeys: [rawPublicKey(client.publicKey)], publicBase: 'http://meet.test', maxConcurrent: 2, maxQueue: 2, maxBody: 32 * 1024, shotTtlMs: 60000, maxShotBytes: 10 * 1024 * 1024, allowPrivate: true, allowHttp: true, trackerStub: true, quiet: true, ...overrides };
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

// ---------- sinds 0.2.0: vals alarm overlap, standaardknop, nadruk, knoptekst ----------
test('logo-icoon naast tekst (flex-rij) is geen overlap; echt overlappende vakken wel', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/logo-rij` }], widths: [1440], selectors: ['.logo', '.echt'], shot: false });
  const m = r.json.metingen[0];
  const ov = (m.meldingen || []).filter((f) => f.code === 'overlap');
  assert.ok(!ov.some((f) => f.selector === '.logo'), JSON.stringify(ov));
  assert.ok(ov.some((f) => f.selector === '.echt'), JSON.stringify(m.meldingen));
  const g = m.blokken[0].tussenruimte[0];
  assert.equal(g.richting, 'naast');
  assert.ok(g.ruimte >= 9 && g.ruimte <= 11, JSON.stringify(g));
});
test('standaardknop: niet de kleine knop in de header, maar de meest voorkomende knop daarbuiten', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/logo-rij` }], widths: [1440], selectors: ['.echt'], shot: false });
  const sk = r.json.metingen[0].standaardknop;
  assert.match(sk.element, /Een/);
  assert.equal(sk.aantal_gelijk, 2);
});
test('nadruk in dezelfde grijze kleur valt niet op; onzichtbare nadruk op donker vlak wordt gemeld; goede nadruk niet', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/nadruk` }], widths: [390], selectors: ['.grijs', '.donker', '.goed'], shot: false });
  const f = r.json.metingen[0].meldingen;
  assert.ok(f.some((x) => x.code === 'nadruk_valt_niet_op' && /grijze/.test(x.melding)), JSON.stringify(f));
  assert.ok(f.some((x) => x.code === 'nadruk_onzichtbaar' && /onzichtbare nadruk/.test(x.melding)), JSON.stringify(f));
  assert.ok(!f.some((x) => /donkere nadruk|gewone nadruk/.test(x.melding)), JSON.stringify(f));
});
test('knoptekst over twee regels zonder binnenruimte boven en onder wordt gemeld, met binnenruimte niet', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/knop-twee-regels` }], widths: [390], selectors: ['.smal', '.ruim'], shot: false });
  const f = r.json.metingen[0].meldingen.filter((x) => x.code === 'knoptekst_zonder_binnenruimte');
  assert.equal(f.length, 1, JSON.stringify(r.json.metingen[0].meldingen));
  assert.match(f[0].melding, /padding/);
});

// ---------- sinds 0.2.0: vóór/na de updates ----------
test('vóór/na: hele pagina als plaatje in het antwoord, mobiel en desktop, formulier gemaskeerd, niets bewaard', async () => {
  const r = await call(meet, { doel: 'voor_na', allowed_hosts: ['localhost'], pages: [{ url: `${base}/voor-na`, label: 'home' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.deepEqual(r.json.metingen.map((m) => m.breedte), [390, 1440]);
  for (const m of r.json.metingen) {
    const buf = Buffer.from(m.beeld, 'base64');
    assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8, 'jpeg');
    assert.equal(m.beeld_breedte, m.breedte);
    assert.ok(m.beeld_hoogte > 100 && m.beeld_hoogte <= 2400);
    assert.equal(m.plaatje, undefined, 'geen plaatje op de meetserver bewaard');
    assert.equal(m.meldingen, undefined, 'geen meting, alleen het beeld');
  }
  // Zelfde pagina twee keer: dezelfde bytes (stabiel genoeg om te vergelijken).
  const again = await call(meet, { doel: 'voor_na', allowed_hosts: ['localhost'], pages: [{ url: `${base}/voor-na` }], widths: [390] });
  assert.equal(again.json.metingen[0].beeld, r.json.metingen[0].beeld);
});
test('vóór/na: te veel pagina\'s of een andere breedte wordt geweigerd; selectors en acties tellen niet', async () => {
  const a = await call(meet, { doel: 'voor_na', allowed_hosts: ['localhost'], pages: [1, 2, 3, 4].map(() => ({ url: `${base}/voor-na` })) });
  assert.equal(a.status, 400);
  const b = await call(meet, { doel: 'voor_na', allowed_hosts: ['localhost'], pages: [{ url: `${base}/voor-na` }], widths: [768] });
  assert.equal(b.status, 400);
  fixtureHits = [];
  const c = await call(meet, { doel: 'voor_na', allowed_hosts: ['localhost'], pages: [{ url: `${base}/link` }], widths: [390], actions: [{ type: 'click', selector: '#weg' }], selectors: ['#weg'] });
  assert.equal(c.status, 200);
  assert.equal(c.json.metingen[0].acties, undefined);
  assert.ok(!fixtureHits.some((h) => h.startsWith('GET /elders')));
});

// ---------- sinds 0.3.0: volgcodes vóór akkoord (besluit 53) ----------
const volg = async (p, extra = {}) => {
  const r = await call(meet, { doel: 'volgcodes', allowed_hosts: ['localhost'], pages: [{ url: `${base}${p}` }], ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  return r.json.metingen[0];
};
test('volgdiensten en hun cookies worden herkend aan adres en naam', () => {
  assert.equal(volgDienst('https://www.facebook.com/tr?id=1&ev=PageView'), 'Meta-pixel');
  assert.equal(volgDienst('https://connect.facebook.net/en_US/fbevents.js'), 'Meta-pixel');
  assert.equal(volgDienst('https://www.facebook.com/somepage'), null, 'gewone Facebook-link is geen pixel');
  assert.equal(volgDienst('https://www.googletagmanager.com/gtm.js?id=GTM-X'), 'Google Tag Manager');
  assert.equal(volgDienst('https://www.googletagmanager.com/gtag/js?id=G-X'), 'Google Analytics');
  assert.equal(volgDienst('https://www.googletagmanager.com/gtag/js?id=AW-1'), 'Google Ads');
  assert.equal(volgDienst('https://region1.google-analytics.com/g/collect?v=2'), 'Google Analytics');
  assert.equal(volgDienst('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/'), 'Google Ads');
  assert.equal(volgDienst('https://static.hotjar.com/c/hotjar-1.js'), 'Hotjar');
  assert.equal(volgDienst('https://www.clarity.ms/tag/abc'), 'Microsoft Clarity');
  assert.equal(volgDienst('https://snap.licdn.com/li.lms-analytics/insight.min.js'), 'LinkedIn Insight');
  assert.equal(volgDienst('https://px.ads.linkedin.com/collect/?pid=1'), 'LinkedIn Insight');
  assert.equal(volgDienst('https://analytics.tiktok.com/i18n/pixel/events.js'), 'TikTok-pixel');
  assert.equal(volgDienst('https://s.pinimg.com/ct/core.js'), 'Pinterest-tag');
  assert.equal(volgDienst('https://ct.pinterest.com/v3/?tid=1'), 'Pinterest-tag');
  assert.equal(volgDienst('https://bat.bing.com/bat.js'), 'Microsoft Ads (Bing)');
  assert.equal(volgDienst('https://tr.snapchat.com/p'), 'Snapchat-pixel');
  assert.equal(volgDienst('https://sc-static.net/scevent.min.js'), 'Snapchat-pixel');
  assert.equal(volgDienst('https://fonts.googleapis.com/css2?family=Inter'), null);
  assert.equal(volgDienst('https://www.google.com/recaptcha/api.js'), null);
  assert.equal(volgCookie('_fbp', 'voorbeeld.nl'), 'Meta-pixel');
  assert.equal(volgCookie('_ga_ABC123', '.voorbeeld.nl'), 'Google Analytics');
  assert.equal(volgCookie('_gcl_au', 'voorbeeld.nl'), 'Google Ads');
  assert.equal(volgCookie('IDE', '.doubleclick.net'), 'Google Ads');
  assert.equal(volgCookie('PHPSESSID', 'voorbeeld.nl'), null);
  assert.equal(volgCookie('wp-wpml_current_language', 'voorbeeld.nl'), null);
});
test('volgcodes (a): Meta-pixel direct geladen: verzoeken en cookie vóór akkoord, zonder te klikken', async () => {
  const m = await volg('/volg-direct');
  const v = m.volgcodes;
  assert.ok(v.gewacht_ms >= 4000, 'ongeveer 5 seconden gewacht na het laden');
  assert.deepEqual(v.diensten, ['Meta-pixel']);
  assert.ok(v.verzoeken.some((r) => r.host === 'connect.facebook.net' && r.soort === 'script'));
  assert.ok(v.verzoeken.some((r) => r.host === 'www.facebook.com' && r.pad === '/tr' && r.soort === 'meting'));
  assert.ok(v.cookies.some((c) => c.naam === '_fbp' && c.dienst === 'Meta-pixel'));
  assert.ok(v.cookies.every((c) => !('waarde' in c) && !('value' in c)), 'nooit cookiewaarden');
  assert.equal(m.breedte, 1440);
  assert.equal(m.plaatje, undefined, 'geen plaatje');
});
test('volgcodes (b): eigen cookiemelding (websitegesprek.nl), pixel-code in de pagina maar pas na akkoord: geen verzoek', async () => {
  fixtureHits = [];
  const m = await volg('/volg-eigen-melding');
  assert.deepEqual(m.volgcodes.diensten, []);
  assert.deepEqual(m.volgcodes.verzoeken, []);
  assert.deepEqual(m.volgcodes.cookies, []);
  assert.deepEqual(m.volgcodes.cookiemelding, { gezien: true, knop: 'Akkoord' }, 'eigen cookiemelding herkend, niet aangeklikt');
});
test('volgcodes (c): Google Consent Mode met standaard "geweigerd": Google laadt zonder cookies', async () => {
  const v = (await volg('/volg-consentmode')).volgcodes;
  assert.equal(v.consent_mode, 'geweigerd');
  assert.ok(v.verzoeken.some((r) => r.dienst === 'Google Analytics' && r.toestemming === 'geweigerd'), JSON.stringify(v.verzoeken));
  assert.deepEqual(v.cookies, [], 'geen Google-cookies');
});
test('volgcodes (d): door de cookiemelding tegengehouden (type="text/plain"): geen verzoek', async () => {
  const v = (await volg('/volg-textplain')).volgcodes;
  assert.deepEqual(v.diensten, []);
});
test('volgcodes (f): Google Tag Manager die pas na akkoord laadt: geen verzoek; knop gezien maar niet aangeklikt', async () => {
  const v = (await volg('/volg-gtm-na-akkoord')).volgcodes;
  assert.deepEqual(v.diensten, []);
  assert.equal(v.cookiemelding.gezien, true);
  assert.equal(v.cookiemelding.knop, 'Accepteer alle cookies');
});
test('volgcodes: code die pas na 1,5 seconde start wordt ook gezien (wachten na het laden)', async () => {
  const v = (await volg('/volg-later')).volgcodes;
  assert.deepEqual(v.diensten, ['Microsoft Clarity']);
  assert.ok(v.cookies.some((c) => c.naam === '_clck'));
});
test('volgcodes: maximaal 3 pagina\'s, één breedte, geen selectors/acties; meerdere pagina\'s geven elk een eigen lijst', async () => {
  const a = await call(meet, { doel: 'volgcodes', allowed_hosts: ['localhost'], pages: [1, 2, 3, 4].map(() => ({ url: `${base}/volg-direct` })) });
  assert.equal(a.status, 400);
  const b = await call(meet, { doel: 'volgcodes', allowed_hosts: ['localhost'], pages: [{ url: `${base}/volg-direct` }, { url: `${base}/volg-textplain` }], actions: [{ type: 'click', selector: '#wg-akkoord' }], selectors: ['#wg-akkoord'] });
  assert.equal(b.status, 200);
  assert.equal(b.json.versie, '0.3.0');
  assert.equal(b.json.metingen.length, 2);
  assert.deepEqual(b.json.metingen.map((m) => m.volgcodes.diensten), [['Meta-pixel'], []]);
  assert.equal(b.json.metingen[0].acties, undefined, 'niets aangeklikt');
});

test('lettergrootte per rol: per rol de groottes in het antwoord; wisselende kop- en broodtekstgrootte gemeld (besluit 177)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/lettergroottes` }, { url: `${base}/lettergroottes-goed` }], widths: [1440], shot: false });
  const [fout, goed] = r.json.metingen;
  assert.deepEqual(fout.lettergroottes.h2.map((g) => g.px).sort(), [28, 32], JSON.stringify(fout.lettergroottes));
  assert.equal(fout.lettergroottes.broodtekst[0].px, 18);
  assert.ok(fout.meldingen.some((x) => x.code === 'lettergrootte_wisselt' && x.rol === 'h2'), JSON.stringify(fout.meldingen));
  assert.ok(fout.meldingen.some((x) => x.code === 'lettergrootte_wisselt' && x.rol === 'broodtekst' && /16 px \(2 keer/.test(x.melding)), JSON.stringify(fout.meldingen));
  assert.ok(!goed.meldingen.some((x) => x.code === 'lettergrootte_wisselt'), JSON.stringify(goed.meldingen));
});
test('iconen: letterteken in een rondje (ook via ::after) en een getekend icoon uit het midden gemeld; gecentreerd niet (besluit 181)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/iconen` }], widths: [1440], shot: false });
  const f = r.json.metingen[0].meldingen.filter((x) => x.code === 'icoon_niet_gecentreerd');
  assert.ok(f.some((x) => /teken.*letterteken \("\+"\)/.test(x.melding)), JSON.stringify(f));
  assert.ok(f.some((x) => /span\.r\.k:.*letterteken/.test(x.melding)), JSON.stringify(f));
  assert.ok(f.some((x) => /scheef.*8 px te rechts/.test(x.melding)), JSON.stringify(f));
  assert.ok(!f.some((x) => /span\.r\.p|span\.s\.recht/.test(x.melding)), JSON.stringify(f));
});

test('lege strook onder de footer op een korte pagina, gemeten op een hoog scherm (besluit 175)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/kort` }], widths: [1440], shot: false, hoog: true });
  const f = r.json.metingen[0].meldingen.filter((x) => x.code === 'lege_strook_onder_footer');
  assert.ok(f.length === 1 && /scherm 1400 px hoog/.test(f[0].melding), JSON.stringify(r.json.metingen[0].meldingen));
});
test('ankers: niet op de kop gemeld; kop onder de vaste kop gemeld; met scroll-margin-top niet (besluit 369)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/ankers` }], widths: [1440], shot: false });
  const m = r.json.metingen[0].meldingen;
  const niet = m.filter((x) => x.code === 'anker_niet_op_kop');
  const onder = m.filter((x) => x.code === 'kop_onder_vaste_kop');
  assert.ok(niet.length === 1 && /#tekst/.test(niet[0].melding), JSON.stringify(niet));
  assert.ok(onder.length === 1 && /#goed/.test(onder[0].melding) && /80px/.test(onder[0].melding), JSON.stringify(onder));
});
test('404-pagina meten met verwachte_status (besluit 175)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/bestaat-niet` }], widths: [390], shot: false, verwachte_status: 404 });
  assert.equal(r.json.metingen[0].status, 404);
  assert.ok(!r.json.metingen[0].fout && Array.isArray(r.json.metingen[0].meldingen), JSON.stringify(r.json.metingen[0]));
  const z = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/bestaat-niet` }], widths: [390], shot: false });
  assert.ok(/status 404/.test(z.json.metingen[0].fout || ''));
});
test('dichtgeklapte vragen geven geen overloop; klikken met action/element werkt ook (besluit 175)', async () => {
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/faq` }], widths: [1440], selectors: ['.faq'], shot: false });
  assert.ok(!r.json.metingen[0].meldingen.some((x) => x.code === 'overloop'), JSON.stringify(r.json.metingen[0].meldingen));
  const k = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/knoppen` }], widths: [1440], shot: false, actions: [{ action: 'click', element: 'summary.s' }] });
  assert.ok(k.json.metingen[0].acties[0].gedaan, JSON.stringify(k.json.metingen[0].acties));
});

test('concept: token in de kop X-WG-Meet, niet in het adres; geen andere domeinen (besluit 332)', async () => {
  fixtureHits = [];
  const tok = 'T'.repeat(43);
  const r = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/concept?wg_meet=${tok}&p=1`, url_kop: `${base}/concept?wg_meet=kop&p=1`, kop: tok }], widths: [390], shot: false });
  const m = r.json.metingen[0];
  assert.equal(m.status, 200, JSON.stringify(m));
  assert.ok(fixtureHits.includes('concept met token ') && !fixtureHits.some((h) => /in adres/.test(h)), JSON.stringify(fixtureHits));
  assert.ok(fixtureHits.includes('plaatje zonder token'), 'token alleen bij het hoofddocument: ' + JSON.stringify(fixtureHits));
  assert.ok((m.tegengehouden || []).some((x) => /andere\.invalid \(concept/.test(x)), JSON.stringify(m.tegengehouden));
  assert.ok(!JSON.stringify(r.json).includes(tok), 'token niet in het antwoord');
  const z = await call(meet, { allowed_hosts: ['localhost'], pages: [{ url: `${base}/concept?p=1`, url_kop: `${base}/concept?p=1`, kop: 'kort' }], widths: [390], shot: false });
  assert.equal(z.status, 400);
});
