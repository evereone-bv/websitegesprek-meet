// Plaatje van een gekozen blok met een strook van het blok erboven en eronder (sinds 0.5.1, besluit 627).
// Reviewvoorwaarden V2–V8 (websitegesprek-reviewuitslag-plaatje-van-blok-627-2026-11-23) en toets Juridisch PB1–PB5
// (register '627 – (' 23 nov 22:01). Alleen voor de hosts van de proefgroep (V5); andere sites houden het plaatje
// van vóór 0.5.1 (blok zelf, of het eerste scherm zonder selector).

// V5: proefgroep zonder handwerk. Na 3 werkdagen zonder fouten haalt een kleine pull request deze lijst weg.
export const PROEF_HOSTS = ['websitegesprek.nl', 'test.websitegesprek.nl', 'evereone.nl'];
export const PLAATJE = { buurMax: 600, blokMax: 2000, maxBreedte: 1200, kwaliteit: 60, totaalMs: 5000, terugvalMs: 2000, verbergMax: 5000 };

/** V5: valt deze host onder de nieuwe uitsnede? (ook www.) */
export function inProef(host, hosts = PROEF_HOSTS) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return hosts.includes(h);
}

/** V4: één stap met de resterende tijd tot de deadline; daarna een fout met de naam van de stap. */
export function stap(belofte, deadline, naam) {
  Promise.resolve(belofte).catch(() => {});
  const rest = deadline - Date.now();
  if (rest <= 0) return Promise.reject(new Error(`tijd op bij ${naam}`));
  let t;
  const klok = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`tijd op bij ${naam}`)), rest); });
  return Promise.race([belofte, klok]).finally(() => clearTimeout(t));
}

// In de pagina (via locator.evaluate, V3: de selector komt nooit als tekst in JavaScript).
// Zoekt het zichtbare blok erboven en eronder en geeft de uitsnede binnen de pagina (B4).
function uitsnedeInPagina(el, o) {
  const zicht = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).position !== 'fixed'; };
  const buur = (s, kant) => { let e = s[kant]; for (let i = 0; e && i < 50 && !zicht(e); i++) e = e[kant]; return e && zicht(e) ? e : null; };
  const y = (e) => { const r = e.getBoundingClientRect(); return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY }; };
  let s = el; let voor = null; let na = null;
  for (let i = 0; s && s !== document.body && i < 30; i++, s = s.parentElement) {
    voor = buur(s, 'previousElementSibling'); na = buur(s, 'nextElementSibling');
    if (voor || na) break;
  }
  const b = y(el); const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const afgekapt = b.bottom - b.top > o.blokMax; const eind = afgekapt ? b.top + o.blokMax : b.bottom;
  const y0 = Math.max(0, b.top - (voor ? Math.min(o.buurMax, Math.max(0, b.top - y(voor).top)) : 0));
  const y1 = Math.min(docH, eind + (na && !afgekapt ? Math.min(o.buurMax, Math.max(0, y(na).bottom - b.bottom)) : 0));
  return { y0: Math.floor(y0), hoogte: Math.max(1, Math.ceil(y1 - y0)), boven: Math.round(b.top - y0), onder: Math.round(Math.max(0, y1 - eind)), afgekapt };
}

// In de pagina: vaste elementen (cookiemelding, chatknop, 'naar boven') en sticky elementen buiten het blok onzichtbaar
// maken, alleen voor het plaatje; de metingen zijn dan al gedaan. B3: hooguit o.max elementen bekijken.
function verbergInPagina(el, o) {
  const alle = document.body ? document.body.getElementsByTagName('*') : [];
  const max = Math.min(alle.length, o.max);
  let n = 0;
  for (let i = 0; i < max; i++) {
    const e = alle[i]; const p = getComputedStyle(e).position;
    const weg = p === 'fixed' || (p === 'sticky' && !el.contains(e));
    if (weg && !e.contains(el)) { e.style.setProperty('visibility', 'hidden', 'important'); n++; }
  }
  return { verborgen: n, bekeken: max };
}

// In een aparte lege pagina (V2): verkleinen met canvas, zonder code of netwerk van de klant.
async function verkleinInLegePagina({ b64, w, q }) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return { b64: c.toDataURL('image/jpeg', q).split(',')[1], h };
}

/** V2 en PB5: verkleinen in een nieuwe browsercontext; al het netwerkverkeer geblokkeerd; daarna alles weg. */
export async function verklein(browser, buf, deadline) {
  const ctx = await stap(browser.newContext({ viewport: { width: 400, height: 300 }, serviceWorkers: 'block' }), deadline, 'verkleinen');
  try {
    await ctx.route('**/*', (r) => r.abort());
    const p = await stap(ctx.newPage(), deadline, 'verkleinen');
    await stap(p.setContent('<!doctype html><title>v</title>'), deadline, 'verkleinen');
    const arg = { b64: buf.toString('base64'), w: PLAATJE.maxBreedte, q: PLAATJE.kwaliteit / 100 };
    const r = await stap(p.evaluate(verkleinInLegePagina, arg), deadline, 'verkleinen');
    return { buf: Buffer.from(r.b64, 'base64'), hoogte: r.h };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Buren, lui ladende plaatjes en vaste elementen; geeft de uitsnede terug. */
async function voorbereiden(page, loc, deadline, env) {
  if (env.plaatjeTestVertragingMs) await stap(new Promise((r) => setTimeout(r, env.plaatjeTestVertragingMs)), deadline, 'buren zoeken');
  const u = await stap(loc.evaluate(uitsnedeInPagina, { buurMax: PLAATJE.buurMax, blokMax: PLAATJE.blokMax }), deadline, 'buren zoeken');
  for (const y of [u.y0, u.y0 + u.hoogte]) {
    await stap(page.evaluate((t) => window.scrollTo(0, t), y), deadline, 'scrollen');
    await stap(page.waitForTimeout(150), deadline, 'scrollen');
  }
  const v = await stap(loc.evaluate(verbergInPagina, { max: PLAATJE.verbergMax }), deadline, 'verbergen');
  return { ...u, verborgen: v.verborgen };
}

/** De uitsnede zelf: blok plus buren, formulieren en cookiemelding afgedekt (PB1), max. 1200 px breed. */
async function uitsnede({ page, browser, width, maskers, env }, sel) {
  const deadline = Date.now() + PLAATJE.totaalMs;
  const loc = page.locator(sel).filter({ visible: true }).first();
  if (!(await stap(loc.count(), deadline, 'blok zoeken'))) throw new Error('blok niet gevonden');
  const u = await voorbereiden(page, loc, deadline, env);
  const clip = { x: 0, y: u.y0, width, height: u.hoogte };
  const opts = { type: 'jpeg', quality: PLAATJE.kwaliteit, fullPage: true, clip, animations: 'disabled', caret: 'hide', mask: maskers(page), maskColor: '#FF00FF' };
  let buf = await stap(page.screenshot({ ...opts, timeout: Math.max(1, deadline - Date.now()) }), deadline, 'opname');
  let hoogte = u.hoogte;
  if (width > PLAATJE.maxBreedte) ({ buf, hoogte } = await verklein(browser, buf, deadline));
  const breedte = Math.min(width, PLAATJE.maxBreedte);
  const info = { selector: sel, boven_px: u.boven, onder_px: u.onder, blok_afgekapt: u.afgekapt, verborgen_vast: u.verborgen, breedte, hoogte, terugval: 'geen' };
  return { buf, info };
}

/** Terugval (V4, V6): eerst het blok zelf, dan het eerste scherm, dan geen plaatje; altijd met reden. */
async function terugval(page, sel, maskers, reden) {
  const t = { timeout: PLAATJE.terugvalMs, type: 'jpeg', mask: maskers(page), maskColor: '#FF00FF' };
  const loc = page.locator(sel).filter({ visible: true }).first();
  let buf = await loc.screenshot({ ...t, quality: 60 }).catch(() => null);
  if (buf) return { buf, info: { selector: sel, terugval: 'blok', reden } };
  buf = await page.screenshot({ ...t, quality: 55 }).catch(() => null);
  if (buf) return { buf, info: { selector: sel, terugval: 'eerste_scherm', reden } };
  return { buf: null, info: { selector: sel, terugval: 'geen_plaatje', reden } };
}

/** Plaatje van vóór 0.5.1 (sites buiten de proefgroep, of zonder selector): ongewijzigd. */
async function oudPlaatje(page, v) {
  const first = v.selectors.length ? page.locator(v.selectors[0]).filter({ visible: true }).first() : null;
  let buf = null;
  if (first && (await first.count())) buf = await first.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }).catch(() => null);
  if (!buf) buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }).catch(() => null);
  return buf;
}

/**
 * Eén aanroep vanuit measureOne (V8). Geeft { plaatje, plaatje_uitsnede } of {}.
 * @param {object} ctx { page, browser, v, width, host, env, maskers }
 */
export async function maakPlaatje({ page, browser, v, width, host, env, maskers }) {
  if (!v.selectors.length || !inProef(host, env.uitsnedeHosts)) {
    const buf = await oudPlaatje(page, v);
    return buf ? { plaatje: env.storeShot(buf) } : {};
  }
  const r = await uitsnede({ page, browser, width, maskers, env }, v.selectors[0])
    .catch((e) => terugval(page, v.selectors[0], maskers, String(e.message).split('\n')[0].slice(0, 120)));
  return { ...(r.buf ? { plaatje: env.storeShot(r.buf) } : {}), plaatje_uitsnede: r.info };
}
