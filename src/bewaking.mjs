// Bewaking van de voorkant van klantsites (sinds meetserver 0.5.0, besluit 481) en van onze eigen servers (besluit 506).
//
// Elke 5 minuten, binnen hetzelfde proces als de meetserver (dus in de container achter de firewall, Review V13):
//  1. Lijst: welke sites bewaakt worden, bepaalt alleen rapportage (ondertekende lijst, elk uur opgehaald). Zonder
//     lijst of met BEWAKING_AAN ongelijk aan 1 gebeurt er niets (Review V14): een wekelijkse update vanaf main zet de
//     bewaking dus nooit vanzelf aan.
//  2. Per site, uitgelogd, zonder cookies, met een user-agent die ons noemt (Juridisch BW1, BW3): GET homepage, hooguit
//     3 eigen stylesheets en de inlogpagina. Tijdslimiet 5 s per verzoek, 15 s per site, 240 s per ronde (V4),
//     antwoord afgebroken na 2 MB of 1 MB (V5). Adressen via checkUrl en resolvePublic, verbinding vastgezet op het
//     gecontroleerde IP-adres, hooguit 3 doorverwijzingen, alleen dezelfde host of een subdomein (V3).
//  3. Uitslag in één ondertekend verzoek naar rapportage; hier wordt niets bewaard (alleen in het geheugen).
//  4. Eigen servers (506): bij 2 keer achter elkaar fout een mail via de SMTP-relay van Google Workspace; een
//     pushbericht komt van de externe bewaker (501), nooit met klantdomeinen (BW4, BW5).
// Gewone https-verzoeken buiten de rij van metingen, geen Playwright (V16).
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { checkUrl, resolvePublic } from './guard.mjs';
import { message, sign, verify } from './keys.mjs';

export const VRAAG_PREFIX = 'wg-bewaking-vraag:v1';
export const LIJST_PREFIX = 'wg-bewaking-lijst:v1';
export const UITSLAG_PREFIX = 'wg-bewaking-uitslag:v1';
export const UA = 'Websitegesprek-bewaking (+https://websitegesprek.nl)';
export const UITKOMSTEN = ['ok', 'traag', 'fout', 'opmaak_weg', 'geblokkeerd', 'niet_gemeten'];

const SKEW_S = 60;
const TRAAG_MS = 3000;

/** Hoort deze host bij de site uit de lijst? Zelfde host, of een subdomein van het domein zonder www. */
export function hoortBij(site, host) {
  const s = String(site).toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const basis = s.replace(/^www\./, '');
  return h === s || h === basis || h.endsWith(`.${basis}`);
}

/** Eén verzoek naar een vastgezet IP-adres, met tijdslimiet en grens aan de grootte (V4, V5). */
export function ophalen(url, ip, { timeoutMs = 5000, maxBytes = 2 * 1024 * 1024, method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const t0 = Date.now();
    let klaar = false;
    const einde = (r) => { if (!klaar) { klaar = true; clearTimeout(timer); resolve({ ms: Date.now() - t0, ...r }); } };
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      lookup: ip ? (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }]) : cb(null, ip, net.isIPv6(ip) ? 6 : 4)) : undefined,
    }, (res) => {
      const delen = [];
      let grootte = 0;
      res.on('data', (c) => {
        grootte += c.length;
        if (grootte > maxBytes) { delen.push(c.subarray(0, Math.max(0, maxBytes - (grootte - c.length)))); res.destroy(); einde({ status: res.statusCode, headers: res.headers, body: Buffer.concat(delen), afgekapt: true }); return; }
        delen.push(c);
      });
      res.on('end', () => einde({ status: res.statusCode, headers: res.headers, body: Buffer.concat(delen) }));
      res.on('error', () => einde({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(delen) }));
    });
    const timer = setTimeout(() => { req.destroy(); einde({ status: 0, fout: 'tijdslimiet', body: Buffer.alloc(0), headers: {} }); }, timeoutMs);
    req.on('error', (e) => einde({ status: 0, fout: e.code || 'verbinding', body: Buffer.alloc(0), headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}

/** GET met hooguit 3 doorverwijzingen; elke stap opnieuw gecontroleerd (V3). */
export async function volgen(url, site, cfg, { maxBytes, deadline }) {
  let huidig = url;
  for (let stap = 0; stap <= 3; stap++) {
    const host = new URL(huidig).hostname;
    if (!hoortBij(site, host)) return { status: 0, fout: 'ander_domein', body: Buffer.alloc(0), headers: {}, ms: 0 };
    let ip;
    try {
      checkUrl(huidig, [host], { allowHttp: cfg.allowHttp });
      ip = await resolvePublic(host, { allowPrivate: cfg.allowPrivate });
    } catch (e) {
      return { status: 0, fout: e.code || 'geweigerd', body: Buffer.alloc(0), headers: {}, ms: 0 };
    }
    const rest = deadline - Date.now();
    if (rest <= 0) return { status: 0, fout: 'budget', body: Buffer.alloc(0), headers: {}, ms: 0 };
    const r = await ophalen(huidig, ip, { timeoutMs: Math.min(cfg.timeoutMs, rest), maxBytes });
    if (r.status >= 300 && r.status < 400 && r.headers.location && stap < 3) {
      try { huidig = new URL(r.headers.location, huidig).toString(); } catch { return r; }
      continue;
    }
    return { ...r, url: huidig };
  }
  return { status: 0, fout: 'te_veel_doorverwijzingen', body: Buffer.alloc(0), headers: {}, ms: 0 };
}

/** Eigen stylesheets uit de HTML: Elementor-opmaak eerst (de storing van Tamara), hooguit 3 (keuzeregel B5). */
export function stylesheets(html, paginaUrl, site) {
  const links = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || tag.match(/\bhref\s*=\s*([^\s>]+)/i);
    if (!href) continue;
    let u;
    try { u = new URL(href[1].replace(/&#0?38;|&amp;/g, '&'), paginaUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !hoortBij(site, u.hostname)) continue;
    u.hash = '';
    links.push(u.toString());
  }
  const uniek = [...new Set(links)];
  const elementor = uniek.filter((l) => /\/elementor\/css\//.test(l));
  return [...elementor, ...uniek.filter((l) => !elementor.includes(l))].slice(0, 3);
}

const geblokkeerd = (r) => r.status === 403 || r.status === 429 || /cf-chl|captcha|sgcaptcha|challenge-platform/i.test(r.body.subarray(0, 20000).toString('latin1'));

/** Meet één site. Geeft alleen site, tijd, statuscode, laadtijd, opmaak ja/nee en uitkomst (Juridisch BW2). */
export async function meetSite(site, cfg) {
  const deadline = Date.now() + cfg.siteBudgetMs;
  const tijd = Math.floor(Date.now() / 1000);
  const basis = `${cfg.allowHttp && cfg.schemaVoorTest ? cfg.schemaVoorTest : 'https'}://${site}`;
  const h = await volgen(`${basis}/`, site, cfg, { maxBytes: 2 * 1024 * 1024, deadline });
  const uit = (uitkomst, opmaak = null) => ({ site, tijd, code: h.status || 0, ms: h.ms || 0, opmaak, uitkomst });
  if (h.fout === 'budget') return uit('niet_gemeten');
  if (h.status && geblokkeerd(h)) return uit('geblokkeerd');
  if (!h.status || h.status >= 400) return uit('fout');
  let opmaak = null;
  for (const css of stylesheets(h.body.toString('utf8'), h.url, site)) {
    const r = await volgen(css, site, cfg, { maxBytes: 1024 * 1024, deadline });
    if (r.fout === 'budget') break;
    opmaak = r.status === 200;
    if (!opmaak) break;
  }
  if (opmaak === false) return uit('opmaak_weg', false);
  // Inlogpagina: verborgen inlogadressen geven 404/403; alleen een serverfout of geen antwoord telt (dossier 3.1.1.5).
  const l = await volgen(`${basis}/wp-login.php`, site, cfg, { maxBytes: 512 * 1024, deadline });
  if (l.fout !== 'budget' && (l.status >= 500 || (l.status === 0 && l.fout !== 'ander_domein'))) return uit('fout', opmaak);
  return uit(h.ms > TRAAG_MS ? 'traag' : 'ok', opmaak);
}

/** Met hooguit n tegelijk; wat na de deadline nog niet begonnen is, wordt 'niet_gemeten' (V4). */
async function metGrens(sites, n, deadline, fn) {
  const uit = [];
  let i = 0;
  const werker = async () => {
    while (i < sites.length) {
      const site = sites[i++];
      if (Date.now() >= deadline) { uit.push({ site, tijd: Math.floor(Date.now() / 1000), code: 0, ms: 0, opmaak: null, uitkomst: 'niet_gemeten' }); continue; }
      uit.push(await fn(site));
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, sites.length) }, werker));
  return uit;
}

/** Ondertekende headers (berichtformaat van keys.mjs, eigen prefix per doel; V1, V2). */
export function ondertekend(privateKey, prefix, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(18).toString('base64url');
  return { ts, nonce, headers: { 'X-WG-Ts': ts, 'X-WG-Nonce': nonce, 'X-WG-Signature': sign(privateKey, message(prefix, ts, nonce, body)) } };
}

/** Minimale SMTP-client (STARTTLS) voor de relay van Google Workspace, verificatie op IP-adres: geen wachtwoord. */
export function smtpMail({ host, port = 587, van, aan, onderwerp, tekst, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    let sock = net.connect(port, host);
    let buf = '';
    const stappen = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('smtp: tijdslimiet')); }, timeoutMs);
    const wacht = () => new Promise((ok, nok) => stappen.push({ ok, nok }));
    const lees = (d) => {
      buf += d.toString('utf8');
      const regels = buf.split('\r\n');
      buf = regels.pop();
      for (const r of regels) if (/^\d{3} /.test(r)) { const s = stappen.shift(); if (s) (/^[23]/.test(r) ? s.ok(r) : s.nok(new Error(`smtp: ${r}`))); }
    };
    sock.on('data', lees);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    const zeg = (r) => { sock.write(`${r}\r\n`); return wacht(); };
    (async () => {
      await wacht();
      await zeg('EHLO meet.websitegesprek.nl');
      await zeg('STARTTLS');
      sock.removeListener('data', lees);
      sock = tls.connect({ socket: sock, servername: host });
      sock.on('data', lees);
      await new Promise((ok) => sock.once('secureConnect', ok));
      await zeg('EHLO meet.websitegesprek.nl');
      await zeg(`MAIL FROM:<${van}>`);
      await zeg(`RCPT TO:<${aan}>`);
      await zeg('DATA');
      const kop = `From: Websitegesprek bewaking <${van}>\r\nTo: <${aan}>\r\nSubject: =?UTF-8?B?${Buffer.from(onderwerp).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
      await zeg(`${kop}${Buffer.from(tekst).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n.`);
      await zeg('QUIT').catch(() => {});
      clearTimeout(timer);
      sock.end();
      resolve(true);
    })().catch((e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

/**
 * De bewaking. cfg: aan, rapportage (basis-URL), eigen (adressen van onze servers), serverKey, clientKeys (KeyObjects
 * van rapportage), timeoutMs, siteBudgetMs, rondeBudgetMs, tegelijk, allowPrivate, allowHttp, mailer (functie of null).
 */
export function createBewaking(cfg, log = () => {}) {
  const st = { lijst: null, lijstTijd: 0, bezig: false, laatsteRonde: null, eigen: new Map() };

  const lijstOphalen = async () => {
    const body = Buffer.alloc(0);
    const { nonce, headers } = ondertekend(cfg.serverKey.privateKey, VRAAG_PREFIX, body);
    const url = `${cfg.rapportage}/wp-json/evereone/v1/bewaking-lijst`;
    const r = await ophalen(url, null, { timeoutMs: cfg.timeoutMs, maxBytes: 1024 * 1024, headers });
    const ts = String(r.headers['x-wg-ts'] || '');
    const ok = r.status === 200 && String(r.headers['x-wg-nonce'] || '') === nonce && Math.abs(Date.now() / 1000 - Number(ts)) <= SKEW_S
      && verify(cfg.clientKeys, message(LIJST_PREFIX, ts, nonce, r.body), String(r.headers['x-wg-signature'] || ''));
    if (!ok) { log({ bewaking: 'lijst', status: r.status, ok: false }); return null; }
    const d = JSON.parse(r.body.toString('utf8'));
    const sites = Array.isArray(d.sites) ? d.sites.map((s) => String(s).toLowerCase()).filter((s) => /^[a-z0-9.-]{3,253}(:\d{2,5})?$/.test(s)).slice(0, 5000) : [];
    return sites;
  };

  const uitslagSturen = async (ronde) => {
    const body = Buffer.from(JSON.stringify(ronde));
    const { headers } = ondertekend(cfg.serverKey.privateKey, UITSLAG_PREFIX, body);
    const r = await ophalen(`${cfg.rapportage}/wp-json/evereone/v1/bewaking-uitslag`, null, { method: 'POST', timeoutMs: cfg.timeoutMs, maxBytes: 64 * 1024, headers: { ...headers, 'Content-Type': 'application/json' }, body });
    return r.status === 200;
  };

  const eigenControleren = async () => {
    for (const url of cfg.eigen || []) {
      const r = await ophalen(url, null, { timeoutMs: cfg.timeoutMs, maxBytes: 256 * 1024 });
      const s = st.eigen.get(url) || { fouten: 0, gemeld: false };
      s.fouten = r.status === 200 ? 0 : s.fouten + 1;
      if (s.fouten >= 2 && !s.gemeld) {
        s.gemeld = true;
        await mail(`🔴 ALARM Websitegesprek: ${new URL(url).hostname} niet bereikbaar`, `De meetserver kan ${url} al twee keer achter elkaar niet bereiken (${r.status || r.fout}).\n\nDit is de eigen bewaking van de meetserver (besluit 506). Kijk in het DRAAIBOEK.`);
      } else if (s.fouten === 0 && s.gemeld) {
        s.gemeld = false;
        await mail(`🟢 Hersteld Websitegesprek: ${new URL(url).hostname} weer bereikbaar`, `${url} is weer bereikbaar.`);
      }
      st.eigen.set(url, s);
    }
  };

  const mail = async (onderwerp, tekst) => {
    log({ bewaking: 'mail', onderwerp });
    if (!cfg.mailer) return false;
    try { await cfg.mailer(onderwerp, tekst); return true; } catch (e) { log({ bewaking: 'mail', fout: String(e.message).slice(0, 120) }); return false; }
  };

  /** Eén ronde. Nooit twee tegelijk (V4). */
  const ronde = async () => {
    if (!cfg.aan || st.bezig) return null;
    st.bezig = true;
    const t0 = Date.now();
    try {
      await eigenControleren();
      if (!st.lijst || Date.now() - st.lijstTijd > 3600 * 1000) {
        const l = await lijstOphalen().catch(() => null);
        if (l) { st.lijst = l; st.lijstTijd = Date.now(); }
      }
      if (!st.lijst || !st.lijst.length) return null;
      const deadline = t0 + cfg.rondeBudgetMs;
      const uitslagen = await metGrens(st.lijst, cfg.tegelijk, deadline, (site) => meetSite(site, cfg).catch(() => ({ site, tijd: Math.floor(Date.now() / 1000), code: 0, ms: 0, opmaak: null, uitkomst: 'fout' })));
      const teTraag = uitslagen.some((u) => u.uitkomst === 'niet_gemeten');
      const r = { ronde: crypto.randomUUID(), tijd: Math.floor(t0 / 1000), duur_ms: Date.now() - t0, te_traag: teTraag, uitslagen };
      st.laatsteRonde = { tijd: r.tijd, sites: uitslagen.length, duur_ms: r.duur_ms, te_traag: teTraag };
      const ok = await uitslagSturen(r).catch(() => false);
      log({ bewaking: 'ronde', sites: uitslagen.length, ms: r.duur_ms, te_traag: teTraag, gestuurd: ok });
      return r;
    } finally {
      st.bezig = false;
    }
  };

  let timer = null;
  return {
    ronde,
    stand: () => ({ aan: !!cfg.aan, sites: st.lijst ? st.lijst.length : 0, laatste_ronde: st.laatsteRonde }),
    start(elkeMs = 5 * 60 * 1000) {
      if (!cfg.aan || timer) return false;
      timer = setInterval(() => { ronde().catch(() => {}); }, elkeMs);
      timer.unref();
      return true;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
