// Voert één meetopdracht uit: per pagina (taal) en per schermbreedte een schone browser-context,
// langs de cache, alleen kijken. Geeft maten en meldingen terug (zie probe.js).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium, webkit, devices } from 'playwright';
import { checkUrl, resolvePublic, isPublicIp, GuardError } from './guard.mjs';

const PROBE_SRC = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
const UA_SUFFIX = 'Websitegesprek-meting/0.1 (+https://websitegesprek.nl)';
const ALLOWED_WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1440, 1920];
const MENU_SELECTORS = [
  '.wp-block-navigation__responsive-container-open',
  '.elementor-menu-toggle',
  '.menu-toggle',
  'button.hamburger',
  '.et_mobile_nav_menu .mobile_menu_bar',
  'button[aria-controls][aria-expanded="false"]',
  'button[aria-label*="menu" i]',
];
// Cookiemeldingen alleen in onze eigen browser verbergen; er wordt niets aangeklikt of geaccepteerd.
const HIDE_BANNERS_CSS = `
#cookie-notice, #cookie-law-info-bar, .cookie-law-info-bar, .cky-consent-container, .cky-overlay,
#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, .cmplz-cookiebanner, #cmplz-cookiebanner-container,
#moove_gdpr_cookie_info_bar, #BorlabsCookieBox, .iubenda-cs-container, #onetrust-consent-sdk,
.cc-window, .cc-banner, #cookie-banner, .cookie-banner, #gdpr-cookie-consent-bar, .wpl-cookie-banner,
#usercentrics-root, #termly-code-snippet-support, .fc-consent-root { display: none !important; }`;

export const LIMITS = { pages: 4, widths: 4, loads: 12, selectors: 5, actions: 5, pageTimeoutMs: 25000, jobTimeoutMs: 90000 };

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new JobError('ongeldige_opdracht', 'Lege opdracht.');
  const pages = Array.isArray(job.pages) ? job.pages : [];
  const widths = Array.isArray(job.widths) && job.widths.length ? job.widths.map(Number) : [390, 768, 1440];
  const selectors = Array.isArray(job.selectors) ? job.selectors.map(String) : [];
  const actions = Array.isArray(job.actions) ? job.actions : [];
  if (!pages.length || pages.length > LIMITS.pages) throw new JobError('ongeldige_opdracht', `Geef 1 tot ${LIMITS.pages} pagina's.`);
  if (widths.length > LIMITS.widths || widths.some((w) => !ALLOWED_WIDTHS.includes(w))) throw new JobError('ongeldige_opdracht', `Schermbreedtes: maximaal ${LIMITS.widths} uit ${ALLOWED_WIDTHS.join(', ')}.`);
  if (pages.length * widths.length > LIMITS.loads) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.loads} metingen per opdracht.`);
  if (selectors.length > LIMITS.selectors || selectors.some((s) => s.length > 200)) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.selectors} selectors van elk maximaal 200 tekens.`);
  if (actions.length > LIMITS.actions) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.actions} acties.`);
  for (const a of actions) {
    if (!a || !['menu', 'click', 'focus', 'hover'].includes(a.type)) throw new JobError('ongeldige_opdracht', 'Acties: menu, click, focus of hover.');
    if (a.type !== 'menu' && (!a.selector || String(a.selector).length > 200)) throw new JobError('ongeldige_opdracht', 'Actie zonder geldige selector.');
  }
  const engine = job.engine === 'webkit' ? 'webkit' : 'chromium';
  return { pages, widths, selectors, actions, engine, shot: job.shot !== false, allowed: job.allowed_hosts || [] };
}

function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set('wg_vers', `${Date.now()}${crypto.randomInt(1000)}`);
  return u.toString();
}

async function runAction(page, action) {
  if (action.type === 'menu') {
    for (const sel of MENU_SELECTORS) {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (await loc.count()) {
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(700);
        return { actie: 'menu', gedaan: true, via: sel };
      }
    }
    return { actie: 'menu', gedaan: false, melding: 'Geen menuknop gevonden.' };
  }
  const loc = page.locator(action.selector).filter({ visible: true }).first();
  if (!(await loc.count())) return { actie: action.type, selector: action.selector, gedaan: false, melding: 'Element niet gevonden.' };
  if (action.type === 'click') {
    // Alleen bedieningselementen die iets openen; nooit links naar elders of verzendknoppen.
    const ok = await loc.evaluate((el) => {
      if (el.closest('form')) return false;
      if (el.tagName === 'A') return (el.getAttribute('href') || '').startsWith('#');
      return el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || el.getAttribute('role') === 'button' || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup');
    });
    if (!ok) return { actie: 'click', selector: action.selector, gedaan: false, melding: 'Alleen knoppen die iets openen mogen worden aangeklikt.' };
    await loc.click({ timeout: 3000 });
  } else if (action.type === 'focus') {
    await loc.focus({ timeout: 3000 });
  } else if (action.type === 'hover') {
    await loc.hover({ timeout: 3000 });
  }
  await page.waitForTimeout(500);
  return { actie: action.type, selector: action.selector, gedaan: true };
}

/**
 * @param {object} job  { allowed_hosts, pages:[{url,label}], widths, selectors, actions, engine, shot }
 * @param {object} env  { allowPrivate, allowHttp, storeShot(buffer) => token }
 */
export async function runJob(job, env = {}) {
  const v = validateJob(job);
  const started = Date.now();
  // Adressen controleren en de hosts vastzetten op het gecontroleerde IP (geen DNS-trucs tussendoor).
  const targets = [];
  const pins = new Map();
  for (const p of v.pages) {
    const { url, host } = checkUrl(p.url, v.allowed, { allowHttp: env.allowHttp });
    if (!pins.has(host)) pins.set(host, await resolvePublic(host, { allowPrivate: env.allowPrivate }));
    targets.push({ url, host, label: p.label ? String(p.label).slice(0, 20) : '' });
  }
  const args = [];
  const rules = [...pins].filter(([, ip]) => isPublicIp(ip)).map(([h, ip]) => `MAP ${h} ${ip}`);
  if (rules.length && v.engine === 'chromium') args.push(`--host-resolver-rules=${rules.join(',')}`);
  const browserType = v.engine === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch({ args, timeout: 20000 });
  const results = [];
  try {
    const work = (async () => {
      for (const t of targets) {
        for (const width of v.widths) {
          results.push(await measureOne(browser, t, width, v, env));
        }
      }
    })();
    let timer;
    await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new JobError('te_lang', 'De meting duurde te lang (meer dan 90 seconden).')), LIMITS.jobTimeoutMs); })]).finally(() => clearTimeout(timer));
  } finally {
    await browser.close().catch(() => {});
  }
  return { ok: true, engine: v.engine, duur_ms: Date.now() - started, metingen: results, vergelijking: compareLanguages(results) };
}

async function measureOne(browser, target, width, v, env) {
  const mobile = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    deviceScaleFactor: 1,
    isMobile: mobile && v.engine === 'chromium',
    hasTouch: mobile,
    acceptDownloads: false,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    userAgent: `${mobile ? devices['iPhone 14'].userAgent : devices['Desktop Chrome'].userAgent} ${UA_SUFFIX}`,
    extraHTTPHeaders: { 'X-Websitegesprek': 'meting' },
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const blocked = [];
  let loaded = false;
  const allowedHosts = v.allowed.map((h) => String(h).toLowerCase());
  await context.route('**/*', async (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.abort(); }
    if (!['http:', 'https:', 'data:', 'blob:'].includes(u.protocol)) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.host}`); return route.abort(); }
    if (/^\[?[\d.:a-f]+\]?$/i.test(u.hostname) && !env.allowPrivate && !isPublicIp(u.hostname.replace(/^\[|\]$/g, ''))) return route.abort();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      if (loaded) { blocked.push('navigatie na het laden'); return route.abort(); }
      if (!allowedHosts.includes(u.hostname.toLowerCase())) { blocked.push(`doorverwijzing naar ${u.hostname}`); return route.abort(); }
      // Doorverwijzingen zelf controleren: alleen binnen de toegestane domeinen.
      let resp;
      try { resp = await route.fetch({ maxRedirects: 0, timeout: LIMITS.pageTimeoutMs }); } catch { return route.abort(); }
      const st = resp.status();
      if (st >= 300 && st < 400) {
        let next;
        try { next = new URL(resp.headers().location || '', req.url()); } catch { next = null; }
        if (!next || !allowedHosts.includes(next.hostname.toLowerCase())) { blocked.push(`doorverwijzing naar ${next ? next.hostname : 'onbekend adres'}`); return route.abort(); }
      }
      return route.fulfill({ response: resp });
    }
    return route.continue();
  });
  const out = { adres: target.url, taal: target.label || undefined, breedte: width };
  try {
    const t0 = Date.now();
    const resp = await page.goto(withCacheBuster(target.url), { waitUntil: 'load', timeout: LIMITS.pageTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    loaded = true;
    out.laadtijd_ms = Date.now() - t0;
    out.status = resp ? resp.status() : 0;
    out.eind_adres = page.url().replace(/([?&])wg_vers=\d+&?/, '$1').replace(/[?&]$/, '');
    if (out.status >= 400) {
      out.fout = `De pagina gaf status ${out.status}.`;
      return out;
    }
    await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});
    out.acties = [];
    for (const a of v.actions) out.acties.push(await runAction(page, a).catch((e) => ({ actie: a.type, gedaan: false, melding: String(e.message).slice(0, 120) })));
    for (const sel of v.selectors) {
      await page.locator(sel).filter({ visible: true }).first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(400);
    const probe = await page.evaluate(`${PROBE_SRC}\nwgProbe(${JSON.stringify({ selectors: v.selectors, mobile, width })})`);
    Object.assign(out, probe);
    if (v.shot && env.storeShot) {
      let buf = null;
      const first = v.selectors.length ? page.locator(v.selectors[0]).filter({ visible: true }).first() : null;
      if (first && (await first.count())) buf = await first.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }).catch(() => null);
      if (!buf) buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }).catch(() => null);
      if (buf) out.plaatje = env.storeShot(buf);
    }
  } catch (e) {
    out.fout = e instanceof GuardError || e instanceof JobError ? e.message : `Meten lukte niet: ${String(e.message).split('\n')[0].slice(0, 160)}`;
  } finally {
    if (blocked.length) out.tegengehouden = [...new Set(blocked)].slice(0, 10);
    await context.close().catch(() => {});
  }
  return out;
}

/** Zelfde blok, zelfde breedte, verschillende talen: meld verschillen in ruimte groter dan 4 px. */
function compareLanguages(results) {
  const out = [];
  const byWidth = new Map();
  for (const r of results) {
    if (!r.blokken) continue;
    if (!byWidth.has(r.breedte)) byWidth.set(r.breedte, []);
    byWidth.get(r.breedte).push(r);
  }
  for (const [width, list] of byWidth) {
    if (list.length < 2) continue;
    const base = list[0];
    for (const other of list.slice(1)) {
      base.blokken.forEach((b, i) => {
        const o = other.blokken[i];
        if (!b || !o || !b.ruimte || !o.ruimte) return;
        for (const k of ['boven', 'onder', 'links', 'rechts']) {
          if (Math.abs(b.ruimte[k] - o.ruimte[k]) > 4) {
            out.push({ code: 'verschil_tussen_talen', melding: `${b.selector} op ${width} px: ruimte ${k} is ${b.ruimte[k]} px (${base.taal || base.adres}) tegen ${o.ruimte[k]} px (${other.taal || other.adres}).` });
          }
        }
        for (const k of ['links', 'rechts']) {
          if (Math.abs(b.vak[k] - o.vak[k]) > 4) out.push({ code: 'verschil_tussen_talen', melding: `${b.selector} op ${width} px staat ${b.vak[k]} px van de ${k}rand (${base.taal || base.adres}) tegen ${o.vak[k]} px (${other.taal || other.adres}).` });
        }
      });
    }
  }
  return out;
}
