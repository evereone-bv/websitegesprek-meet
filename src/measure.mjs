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

// Volgcodes vóór akkoord (sinds 0.3.0, besluit Raymond 53): de pagina openen als nieuwe bezoeker (schone browser,
// geen cookies), nergens op klikken, ~5 s wachten na het laden en noteren welke verzoeken naar bekende volgdiensten
// gaan en welke cookies van die diensten er staan. Meetverzoeken (pixels, beacons) worden hier beantwoord met een lege
// 204 en gaan dus niet echt naar de volgdienst: geen nepbezoek in de statistieken van de klant. Alleen de scripts zelf
// worden echt geladen, zodat ook de cookies die zij zetten zichtbaar worden. Niets wordt bewaard; cookiewaarden nooit.
export const VOLGCODES = { pages: 3, width: 1440, waitMs: 5000, maxRequests: 40, maxCookies: 40 };
export const VOLGDIENSTEN = [
  ['Google Tag Manager', (h, p) => h.endsWith('googletagmanager.com') && p.startsWith('/gtm.js')],
  ['Google Ads', (h, p, q) => (h.endsWith('googletagmanager.com') && p.startsWith('/gtag/') && /(^|&)id=AW-/i.test(q)) || h.endsWith('googleadservices.com') || h === 'doubleclick.net' || h.endsWith('.doubleclick.net')],
  ['Google Analytics', (h, p) => h === 'google-analytics.com' || h.endsWith('.google-analytics.com') || (h.endsWith('googletagmanager.com') && p.startsWith('/gtag/')) || (h === 'analytics.google.com' && p.includes('collect'))],
  ['Meta-pixel', (h, p) => h === 'connect.facebook.net' || (/(^|\.)facebook\.com$/.test(h) && /^\/tr\/?$/.test(p))],
  ['Hotjar', (h) => /(^|\.)hotjar\.(com|io)$/.test(h)],
  ['Microsoft Clarity', (h) => /(^|\.)clarity\.ms$/.test(h)],
  ['LinkedIn Insight', (h, p) => h === 'snap.licdn.com' || h === 'px.ads.linkedin.com' || (/(^|\.)linkedin\.com$/.test(h) && p.startsWith('/px'))],
  ['TikTok-pixel', (h) => h === 'analytics.tiktok.com' || h.endsWith('.analytics.tiktok.com')],
  ['Pinterest-tag', (h, p) => (h === 's.pinimg.com' && p.startsWith('/ct/')) || h === 'ct.pinterest.com'],
  ['Microsoft Ads (Bing)', (h) => h === 'bat.bing.com'],
  ['Snapchat-pixel', (h, p) => (h === 'sc-static.net' && p.startsWith('/scevent')) || /^tr(-shadow)?\.snapchat\.com$/.test(h)],
];
export const VOLGCOOKIES = [
  ['Google Analytics', /^(_ga|_ga_.+|_gid|_gat.*|__utm[a-z]|_dc_gtm_.+)$/],
  ['Google Ads', /^(_gcl_.+|_gac_.+|IDE|DSID|test_cookie)$/],
  ['Meta-pixel', /^(_fbp|_fbc|fr)$/],
  ['Hotjar', /^_hj/],
  ['Microsoft Clarity', /^(_clck|_clsk|CLID)$/],
  ['Microsoft Ads (Bing)', /^(_uetsid|_uetvid|_uetmsclkid|MUID)$/],
  ['LinkedIn Insight', /^(li_.+|lidc|bcookie|bscookie|UserMatchHistory|AnalyticsSyncHistory|ln_or)$/],
  ['TikTok-pixel', /^(_ttp|_tt_enable_cookie|ttcsid.*)$/],
  ['Pinterest-tag', /^(_pin_unauth|_pinterest_.+|_epik|_derived_epik)$/],
  ['Snapchat-pixel', /^(_scid|_scid_r|_sctr|sc_at|_schn)$/],
];
const VOLGDOMEINEN = [
  ['Meta-pixel', /(^|\.)facebook\.(com|net)$/], ['Google Ads', /(^|\.)doubleclick\.net$/], ['LinkedIn Insight', /(^|\.)linkedin\.com$/],
  ['TikTok-pixel', /(^|\.)tiktok\.com$/], ['Pinterest-tag', /(^|\.)pinterest\.com$/], ['Microsoft Ads (Bing)', /(^|\.)bing\.com$/],
  ['Microsoft Clarity', /(^|\.)clarity\.ms$/], ['Hotjar', /(^|\.)hotjar\.(com|io)$/], ['Snapchat-pixel', /(^|\.)snapchat\.com$/],
  ['Google Analytics', /(^|\.)google-analytics\.com$/],
];

/** Welke volgdienst hoort bij dit adres (of null). */
export function volgDienst(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  const q = u.search.replace(/^\?/, '');
  for (const [naam, f] of VOLGDIENSTEN) if (f(h, u.pathname, q)) return naam;
  return null;
}

/** Welke volgdienst hoort bij deze cookie (naam, domein), of null. */
export function volgCookie(name, domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  for (const [naam, re] of VOLGDOMEINEN) if (re.test(d)) return naam;
  for (const [naam, re] of VOLGCOOKIES) if (re.test(String(name))) return naam;
  return null;
}

// Alleen in de teststand: volgdiensten worden nooit echt benaderd; deze kleine scripts doen na wat de echte doen
// (cookie zetten en een meetverzoek sturen), zodat de teststraat zonder internet en zonder echte volgdiensten draait.
const TEST_STUBS = {
  'Meta-pixel': "document.cookie='_fbp=fb.1.0.0;path=/';new Image().src='https://www.facebook.com/tr?id=0&ev=PageView';",
  'Google Analytics': "(function(){var d=window.dataLayer||[],den=false;for(var i=0;i<d.length;i++){var a=Array.prototype.slice.call(d[i]||[]);if(a[0]==='consent'&&a[1]==='default'&&a[2]&&(a[2].analytics_storage==='denied'||a[2].ad_storage==='denied'))den=true;}if(!den)document.cookie='_ga=GA1.1.0.0;path=/';new Image().src='https://region1.google-analytics.com/g/collect?v=2&gcs='+(den?'G100':'G111');})();",
  'Google Tag Manager': "document.cookie='_ga=GA1.1.0.1;path=/';new Image().src='https://www.google-analytics.com/g/collect?v=2&gcs=G111';",
  'Hotjar': "document.cookie='_hjSessionUser_1=x;path=/';",
  'Microsoft Clarity': "document.cookie='_clck=x;path=/';",
};

export const LIMITS = { pages: 4, widths: 4, loads: 12, selectors: 5, actions: 5, pageTimeoutMs: 25000, jobTimeoutMs: 90000 };

// Vóór/na de updates (sinds 0.2.0, besluit 36/48): schermafbeelding van de hele pagina (tot SHOT_MAX_H px hoog),
// uitgelogd (schone browser), cookiemelding verborgen, formulieren en bewegende delen gemaskeerd. Het plaatje gaat
// alleen in het ondertekende antwoord terug naar de site; hier wordt niets bewaard.
export const VOOR_NA = { pages: 3, widths: [390, 1440], maxHeight: 2400, quality: 60 };
const MASK_SELECTORS = [
  'form', 'iframe', 'video', 'canvas', 'embed', 'object', 'marquee',
  '.swiper', '.swiper-container', '.slick-slider', '.owl-carousel', '.flexslider', '.splide', '.glide', '.carousel',
  '.elementor-slides', '.elementor-image-carousel-wrapper', '.elementor-testimonial-carousel', '.n2-section-smartslider',
  '.rev_slider_wrapper', '.rs-module-wrap', '.metaslider', '.wp-block-cover__video-background', '[class*="slider"]', '[class*="carousel"]',
  '[aria-live]', '[class*="countdown"]', '.wpcf7', '.wpforms-container', '.gform_wrapper', '.frm-fluent-form', '.fluentform',
  '#cookie-notice', '#cookie-law-info-bar', '.cky-consent-container', '#CybotCookiebotDialog', '.cmplz-cookiebanner', '#BorlabsCookieBox',
  '.iubenda-cs-container', '#onetrust-consent-sdk', '.cc-window', '#cookie-banner', '.cookie-banner', '#usercentrics-root',
];

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
  // Sinds 0.4.1: ook {action|actie: 'click', element: '...'} accepteren (Claude gebruikte soms die namen).
  const actions = (Array.isArray(job.actions) ? job.actions : []).map((a) => (a && typeof a === 'object'
    ? { type: String(a.type || a.action || a.actie || '').toLowerCase(), selector: a.selector || a.element || a.doel || undefined }
    : a));
  if (!pages.length || pages.length > LIMITS.pages) throw new JobError('ongeldige_opdracht', `Geef 1 tot ${LIMITS.pages} pagina's.`);
  if (widths.length > LIMITS.widths || widths.some((w) => !ALLOWED_WIDTHS.includes(w))) throw new JobError('ongeldige_opdracht', `Schermbreedtes: maximaal ${LIMITS.widths} uit ${ALLOWED_WIDTHS.join(', ')}.`);
  if (pages.length * widths.length > LIMITS.loads) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.loads} metingen per opdracht.`);
  if (selectors.length > LIMITS.selectors || selectors.some((s) => s.length > 200)) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.selectors} selectors van elk maximaal 200 tekens.`);
  if (actions.length > LIMITS.actions) throw new JobError('ongeldige_opdracht', `Maximaal ${LIMITS.actions} acties.`);
  for (const a of actions) {
    if (!a || !['menu', 'click', 'focus', 'hover'].includes(a.type)) throw new JobError('ongeldige_opdracht', 'Acties: menu, click, focus of hover.');
    if (a.type !== 'menu' && (!a.selector || String(a.selector).length > 200)) throw new JobError('ongeldige_opdracht', 'Actie zonder geldige selector.');
  }
  // Sinds 0.4.3 (besluit 332): een concept meet je met een eenmalig token in de kop X-WG-Meet in plaats van in het
  // adres, zodat het niet in de serverlogs van de site komt. De plugin stuurt dan url_kop (adres zonder token) en kop.
  for (const p of pages) {
    if (p && p.kop !== undefined) {
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(p.kop)) || !p.url_kop) throw new JobError('ongeldige_opdracht', 'Concept: ongeldig token of adres.');
      p.url = String(p.url_kop);
      p.kop = String(p.kop);
    }
  }
  const engine = job.engine === 'webkit' ? 'webkit' : 'chromium';
  if (job.doel === 'volgcodes') {
    if (pages.length > VOLGCODES.pages) throw new JobError('ongeldige_opdracht', `Volgcodes: maximaal ${VOLGCODES.pages} pagina's.`);
    return { pages, widths: [VOLGCODES.width], selectors: [], actions: [], engine: 'chromium', shot: false, allowed: job.allowed_hosts || [], volgcodes: true };
  }
  if (job.doel === 'voor_na') {
    if (pages.length > VOOR_NA.pages) throw new JobError('ongeldige_opdracht', `Vóór/na: maximaal ${VOOR_NA.pages} pagina's.`);
    const w = Array.isArray(job.widths) && job.widths.length ? widths : VOOR_NA.widths;
    if (w.some((x) => !VOOR_NA.widths.includes(x))) throw new JobError('ongeldige_opdracht', `Vóór/na: schermbreedtes ${VOOR_NA.widths.join(' en ')}.`);
    return { pages, widths: w, selectors: [], actions: [], engine: 'chromium', shot: true, allowed: job.allowed_hosts || [], voorNa: true };
  }
  // Sinds 0.4.1: een pagina die bewust een foutstatus geeft (zoals de 404-pagina) toch meten; en op een hoog scherm
  // meten om een lege strook onder de footer te zien (besluit 175).
  const verwacht = Number(job.verwachte_status) || 0;
  if (verwacht && (verwacht < 400 || verwacht > 499)) throw new JobError('ongeldige_opdracht', 'verwachte_status: alleen 400 tot en met 499 (bijv. 404).');
  return { pages, widths, selectors, actions, engine, shot: job.shot !== false, allowed: job.allowed_hosts || [], verwacht, hoog: !!job.hoog };
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
    targets.push({ url, host, label: p.label ? String(p.label).slice(0, 20) : '', kop: p.kop || '' });
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
    viewport: { width, height: v.hoog ? (mobile ? 1200 : 1400) : (mobile ? 844 : 900) },
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
  const volg = { verzoeken: [] };
  let loaded = false;
  const allowedHosts = v.allowed.map((h) => String(h).toLowerCase());
  await context.route('**/*', async (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.abort(); }
    if (!['http:', 'https:', 'data:', 'blob:'].includes(u.protocol)) return route.abort();
    // Besluit 332: bij een concept geen enkel verzoek naar een ander domein (volgcodes en dergelijke zien het adres niet).
    if (target.kop && ['http:', 'https:'].includes(u.protocol) && !allowedHosts.includes(u.hostname.toLowerCase())) {
      blocked.push(`${u.hostname} (concept: geen andere domeinen)`);
      return route.abort();
    }
    if (v.volgcodes) {
      const dienst = volgDienst(u);
      if (dienst) {
        const type = req.resourceType();
        const gcs = u.searchParams.get('gcs') || '';
        if (volg.verzoeken.length < VOLGCODES.maxRequests) volg.verzoeken.push({ dienst, host: u.hostname, pad: u.pathname.slice(0, 80), soort: type === 'script' ? 'script' : 'meting', ...(/^G1[0-][0-]$/.test(gcs) ? { toestemming: 'geweigerd' } : {}) });
        if (env.trackerStub) return route.fulfill(type === 'script' ? { status: 200, contentType: 'application/javascript', body: TEST_STUBS[dienst] || '' } : { status: 204, body: '' });
        if (type !== 'script') return route.fulfill({ status: 204, body: '' });
        if (req.method() === 'GET') return route.continue();
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.host}`); return route.abort(); }
    if (/^\[?[\d.:a-f]+\]?$/i.test(u.hostname) && !env.allowPrivate && !isPublicIp(u.hostname.replace(/^\[|\]$/g, ''))) return route.abort();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      if (loaded) { blocked.push('navigatie na het laden'); return route.abort(); }
      if (!allowedHosts.includes(u.hostname.toLowerCase())) { blocked.push(`doorverwijzing naar ${u.hostname}`); return route.abort(); }
      // Doorverwijzingen zelf controleren: alleen binnen de toegestane domeinen.
      let resp;
      // Besluit 332: het token alleen in de kop van het hoofddocument, alleen naar het eigen domein.
      const opts = { maxRedirects: 0, timeout: LIMITS.pageTimeoutMs };
      if (target.kop) opts.headers = { ...req.headers(), 'x-wg-meet': target.kop };
      try { resp = await route.fetch(opts); } catch { return route.abort(); }
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
    if (out.status >= 400 && out.status !== v.verwacht) {
      out.fout = `De pagina gaf status ${out.status}.`;
      return out;
    }
    if (v.volgcodes) {
      out.volgcodes = await watchTrackers(page, context, volg, env);
      return out;
    }
    await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});
    if (v.voorNa) {
      Object.assign(out, await shootFull(page, width));
      return out;
    }
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

/** Volgcodes: wachten, dan verzoeken, cookies, Consent Mode en een zichtbare cookiemelding (zonder te klikken). */
async function watchTrackers(page, context, volg, env) {
  const wait = Number.isFinite(env.volgWaitMs) ? env.volgWaitMs : VOLGCODES.waitMs;
  await page.waitForTimeout(wait);
  const cookies = [];
  for (const c of await context.cookies().catch(() => [])) {
    const dienst = volgCookie(c.name, c.domain);
    if (dienst && cookies.length < VOLGCODES.maxCookies) cookies.push({ dienst, naam: c.name.slice(0, 60), domein: c.domain.replace(/^\./, '') });
  }
  const inPage = await page.evaluate(() => {
    // Google Consent Mode: laatste stand in dataLayer (standaard, of een update).
    let cm = null;
    const dl = Array.isArray(window.dataLayer) ? window.dataLayer : [];
    for (const e of dl) {
      const a = e && typeof e === 'object' && typeof e.length === 'number' ? Array.from(e) : null;
      if (a && a[0] === 'consent' && (a[1] === 'default' || a[1] === 'update') && a[2] && typeof a[2] === 'object') {
        cm = (a[2].ad_storage === 'denied' || a[2].analytics_storage === 'denied') ? 'geweigerd' : 'toegestaan';
      }
    }
    // Zichtbare cookiemelding: een zichtbare knop "akkoord/accepteren/..." in een blok waarin "cookie" staat.
    const words = /(akkoord|accepte|accept|toestaan|allow|agree|alle cookies|instemmen|consent|zustimmen|akzeptieren|accepter)/i;
    let knop = '';
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
      const t = (el.innerText || el.value || '').trim();
      if (!t || t.length > 60 || !words.test(t)) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!r.width || !r.height || st.visibility === 'hidden' || st.display === 'none') continue;
      let p = el.parentElement;
      for (let i = 0; p && i < 8; i++, p = p.parentElement) {
        const txt = (p.innerText || '').slice(0, 4000);
        const idc = `${p.id} ${typeof p.className === 'string' ? p.className : ''}`;
        if (/cookie/i.test(txt) || /cookie|consent|gdpr|cmp/i.test(idc)) { knop = t.slice(0, 40); break; }
      }
      if (knop) break;
    }
    return { consent_mode: cm, cookiemelding: knop ? { gezien: true, knop } : { gezien: false } };
  }).catch(() => ({ consent_mode: null, cookiemelding: { gezien: false } }));
  const seen = new Set();
  const verzoeken = volg.verzoeken.filter((r) => { const k = `${r.dienst}|${r.host}|${r.pad}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const diensten = [...new Set([...verzoeken.map((r) => r.dienst), ...cookies.map((c) => c.dienst)])];
  return { gewacht_ms: wait, diensten, verzoeken, cookies, consent_mode: inPage.consent_mode, cookiemelding: inPage.cookiemelding };
}

/** Vóór/na: hele pagina (tot VOOR_NA.maxHeight), formulieren en bewegende delen gemaskeerd, als base64 in het antwoord. */
async function shootFull(page, width) {
  // Eén keer naar beneden en terug, zodat afbeeldingen die pas bij scrollen laden er vóór en na allebei staan.
  await page.evaluate(async (max) => {
    const step = Math.max(300, window.innerHeight - 100);
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  }, VOOR_NA.maxHeight).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.addStyleTag({ content: '*,*::before,*::after{caret-color:transparent!important;scroll-behavior:auto!important}html{scrollbar-width:none}::-webkit-scrollbar{display:none}' }).catch(() => {});
  const docH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)).catch(() => 0);
  const h = Math.max(1, Math.min(VOOR_NA.maxHeight, docH || VOOR_NA.maxHeight));
  const mask = MASK_SELECTORS.map((sel) => page.locator(sel));
  const buf = await page.screenshot({ type: 'jpeg', quality: VOOR_NA.quality, fullPage: true, clip: { x: 0, y: 0, width, height: h }, animations: 'disabled', caret: 'hide', mask, maskColor: '#FF00FF', timeout: 15000 });
  return { beeld: buf.toString('base64'), beeld_breedte: width, beeld_hoogte: h, pagina_hoogte: docH, gemaskeerd: 'formulieren, cookiemelding en bewegende delen (sliders, video, iframes)' };
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
