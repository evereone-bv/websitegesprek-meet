// Draait IN de pagina (page.evaluate). Geen afhankelijkheden, geen netwerk, verandert niets aan de pagina.
// Meet de gevraagde blokken en zoekt bekende fouten. Alle maten in CSS-pixels.
// eslint-disable-next-line no-unused-vars
function wgProbe(opts) {
  // Op een telefoon rekt de browser het venster op tot de breedste inhoud; meet daarom tegen de echte schermbreedte.
  const vw = opts.width || window.innerWidth;
  const R = (n) => Math.round(n * 10) / 10;
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // Sinds 0.4.1: inhoud van een dichtgeklapte vraag (<details> zonder open) is niet te zien, ook al heeft hij in
    // nieuwe Chrome-versies wel afmetingen (melding 'overloop' bij een FAQ-blok, Marketing 8 nov).
    const dicht = el.closest && el.closest('details:not([open])');
    if (dicht && dicht !== el && !el.closest('summary')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const label = (el) => {
    const cls = (el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2) : []).map((c) => '.' + c).join('');
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return el.tagName.toLowerCase() + cls + (t ? ` "${t}"` : '');
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: R(r.left), y: R(r.top + window.scrollY), w: R(r.width), h: R(r.height), links: R(r.left), rechts: R(vw - r.right) };
  };
  const px = (v) => parseFloat(v) || 0;
  const parseColor = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const effectiveBg = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // afbeelding: niet betrouwbaar te meten
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.95) return c;
      if (c && c.a > 0.05) return null; // halfdoorzichtig: overslaan
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const findings = [];
  const add = (code, message, extra) => findings.push(Object.assign({ code, melding: message }, extra || {}));

  // 1. Horizontaal scrollen (WCAG 1.4.10).
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    const culprits = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (culprits.length >= 3) break;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width <= vw + 1 && ![...el.children].some((c) => visible(c) && c.getBoundingClientRect().right > vw + 1)) culprits.push(label(el));
    }
    add('horizontaal_scrollen', `De pagina is ${docW} px breed op een scherm van ${vw} px: bezoekers moeten opzij scrollen.`, { regel: 'WCAG 2.2 AA 1.4.10', elementen: culprits });
  }

  // Standaardknop van de site (eerste zichtbare knop buiten de gemeten blokken).
  const btnSel = '.wp-block-button__link, .wp-element-button, .elementor-button, .button, button[type=submit], input[type=submit]';
  const measuredEls = [];

  const elements = [];
  for (const sel of opts.selectors || []) {
    let el = null;
    try {
      el = [...document.querySelectorAll(sel)].find(visible) || null;
    } catch {
      elements.push({ selector: sel, gevonden: false, fout: 'ongeldige selector' });
      continue;
    }
    if (!el) {
      elements.push({ selector: sel, gevonden: false });
      continue;
    }
    measuredEls.push(el);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const innerTop = r.top + px(cs.borderTopWidth);
    const innerBottom = r.bottom - px(cs.borderBottomWidth);
    const innerLeft = r.left + px(cs.borderLeftWidth);
    const innerRight = r.right - px(cs.borderRightWidth);
    const kids = [...el.children].filter(visible);
    const kidInfo = kids.map((k) => {
      const kr = k.getBoundingClientRect();
      const kcs = getComputedStyle(k);
      return { element: label(k), boven: R(kr.top - innerTop), onder: R(innerBottom - kr.bottom), links: R(kr.left - innerLeft), rechts: R(innerRight - kr.right), h: R(kr.height), marge: `${kcs.marginTop} ${kcs.marginBottom}` };
    });
    // Het zichtbare bereik van de inhoud: ook kleinkinderen die buiten hun ouder lopen tellen mee.
    let cTop = Infinity, cBottom = -Infinity, cLeft = Infinity, cRight = -Infinity;
    // Uitklapmenu's en andere zwevende delen (position absolute/fixed, ook hun inhoud) horen over de pagina heen
    // te vallen: die tellen niet mee als overloop (Puglia taalkeuze, 6 nov).
    const floating = (d) => {
      for (let n = d; n && n !== el; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'absolute' || p === 'fixed') return true;
      }
      return false;
    };
    for (const d of el.querySelectorAll('*')) {
      if (!visible(d)) continue;
      if (floating(d)) continue;
      const dr = d.getBoundingClientRect();
      cTop = Math.min(cTop, dr.top); cBottom = Math.max(cBottom, dr.bottom);
      cLeft = Math.min(cLeft, dr.left); cRight = Math.max(cRight, dr.right);
    }
    const info = { selector: sel, gevonden: true, element: label(el), vak: box(el), binnenruimte_css: cs.padding, achtergrond: cs.backgroundColor, onderdelen: kidInfo };
    if (Number.isFinite(cTop)) {
      info.ruimte = { boven: R(cTop - innerTop), onder: R(innerBottom - cBottom), links: R(cLeft - innerLeft), rechts: R(innerRight - cRight) };
      const gaps = [];
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
        // Sinds meetserver 0.2.0: alleen echte overlap (horizontaal én verticaal). Naast elkaar in een rij
        // (logo-icoon naast tekst, flex-rij) is de ruimte de afstand opzij, geen overlap (websitegesprek.nl, 6 nov).
        const hOver = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const vOver = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const naast = vOver > 1 && hOver <= 1;
        gaps.push({
          tussen: `${label(kids[i - 1])} en ${label(kids[i])}`,
          richting: naast ? 'naast' : 'onder',
          ruimte: naast ? R(Math.max(a.left, b.left) - Math.min(a.right, b.right)) : R(b.top - a.bottom),
          overlap: hOver > 1 && vOver > 1 ? { breed: R(hOver), hoog: R(vOver) } : null,
        });
      }
      info.tussenruimte = gaps;
      const s = info.ruimte;
      if (s.boven >= 0 && s.onder >= 0 && Math.abs(s.boven - s.onder) > 4) add('binnenruimte_ongelijk', `${label(el)}: ruimte boven ${s.boven} px, onder ${s.onder} px.`, { regel: 'Ontwerpbasis: binnenruimte boven en onder gelijk', selector: sel });
      if (s.links >= 0 && s.rechts >= 0 && Math.abs(s.links - s.rechts) > 4 && cs.textAlign === 'center') add('binnenruimte_ongelijk', `${label(el)}: ruimte links ${s.links} px, rechts ${s.rechts} px.`, { regel: 'Ontwerpbasis: binnenruimte links en rechts gelijk', selector: sel });
      if (s.boven < -1 || s.onder < -1 || s.links < -1 || s.rechts < -1) add('overloop', `${label(el)}: inhoud loopt buiten het blok (boven ${s.boven}, onder ${s.onder}, links ${s.links}, rechts ${s.rechts} px).`, { selector: sel });
      for (const g of gaps) {
        if (g.overlap) add('overlap', `${g.tussen} overlappen elkaar (${g.overlap.breed} x ${g.overlap.hoog} px).`, { selector: sel });
        delete g.overlap;
      }
    }
    // Knop of link met binnenruimte die zich als tekst gedraagt (loopt over tekst en rand heen).
    for (const d of el.querySelectorAll('a, button, span, label')) {
      if (!visible(d)) continue;
      const dcs = getComputedStyle(d);
      if (dcs.display !== 'inline') continue;
      const vpad = px(dcs.paddingTop) + px(dcs.paddingBottom);
      const bg = parseColor(dcs.backgroundColor);
      const hasBox = (bg && bg.a > 0.05) || px(dcs.borderTopWidth) > 0;
      if (vpad > 4 && hasBox) add('inline_met_binnenruimte', `${label(d)} gedraagt zich als tekst (display: inline) maar heeft ${vpad} px binnenruimte: hij loopt over de tekst en de rand heen. Oplossing: display: inline-block.`, { selector: sel });
    }
    // Knoppen in het blok tegenover de standaardknop van de site.
    info.knoppen = [...el.querySelectorAll(btnSel)].filter(visible).map((b) => ({ element: label(b), h: R(b.getBoundingClientRect().height) }));
    // Contrast (WCAG 1.4.3), alleen elementen met eigen tekst.
    let contrastCount = 0;
    for (const d of [el, ...el.querySelectorAll('*')]) {
      if (contrastCount >= 5) break;
      if (!visible(d)) continue;
      const own = [...d.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) continue;
      const dcs = getComputedStyle(d);
      const fg = parseColor(dcs.color), bg = effectiveBg(d);
      if (!fg || !bg || fg.a < 0.95) continue;
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = px(dcs.fontSize), bold = Number(dcs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) {
        contrastCount++;
        add('contrast_laag', `${label(d)}: contrast ${R(ratio)}:1, nodig ${need}:1.`, { regel: 'WCAG 2.2 AA 1.4.3', selector: sel });
      }
    }
    // Afgesneden tekst.
    for (const d of [el, ...el.querySelectorAll('*')]) {
      if (!visible(d)) continue;
      const dcs = getComputedStyle(d);
      if (!/hidden|clip/.test(dcs.overflowX + dcs.overflow) || dcs.textOverflow === 'ellipsis') continue;
      if (d.scrollWidth > d.clientWidth + 1 && d.innerText && d.innerText.trim()) add('tekst_afgesneden', `${label(d)}: tekst valt weg (${d.scrollWidth} px inhoud in ${d.clientWidth} px).`, { selector: sel });
    }
    elements.push(info);
  }

  // Standaardknop (sinds meetserver 0.2.0): knoppen buiten header en navigatie, de meest voorkomende hoogte
  // (bij gelijkspel de eerste). Een knop in de header is vaak kleiner en geen goede maat (websitegesprek.nl, 6 nov).
  const chrome = 'header, nav, [role=banner], [role=navigation], .site-header, #masthead';
  const candidates = [...document.querySelectorAll(btnSel)].filter((b) => visible(b) && !measuredEls.some((m) => m.contains(b)));
  const outside = candidates.filter((b) => !b.closest(chrome));
  const pool = outside.length ? outside : candidates;
  const byHeight = new Map();
  for (const b of pool) {
    const h = Math.round(b.getBoundingClientRect().height);
    if (!byHeight.has(h)) byHeight.set(h, []);
    byHeight.get(h).push(b);
  }
  let std = null;
  for (const list of byHeight.values()) if (!std || list.length > std.length) std = list;
  std = std ? std[0] : null;
  const standaardKnop = std ? { element: label(std), h: R(std.getBoundingClientRect().height), aantal_gelijk: byHeight.get(Math.round(std.getBoundingClientRect().height)).length } : null;
  if (standaardKnop) {
    for (const e of elements) for (const k of e.knoppen || []) {
      if (Math.abs(k.h - standaardKnop.h) > 2) add('knop_hoogte_afwijkend', `${k.element} is ${k.h} px hoog; de standaardknop van de site is ${standaardKnop.h} px.`, { regel: 'Ontwerpbasis: een knop heeft de hoogte van de standaardknop', selector: e.selector });
    }
  }

  const scopeAll = measuredEls.length ? measuredEls : [document.body];
  const isGrey = (c) => {
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    const avg = (c.r + c.g + c.b) / 3;
    return mx > 0 && (mx - mn) / mx <= 0.2 && avg >= 80 && avg <= 205;
  };
  const sameColor = (a, b) => a && b && Math.abs(a.r - b.r) <= 6 && Math.abs(a.g - b.g) <= 6 && Math.abs(a.b - b.b) <= 6;

  // Nadruk (sinds meetserver 0.2.0): vet binnen een alinea of opsomming moet opvallen. Zelfde grijze kleur als de
  // tekst eromheen, of niet vetter, valt niet op; bijna geen contrast met de achtergrond is onzichtbaar
  // (websitegesprek.nl, 6 nov: vet zag er niet vet uit, en een globale fix maakte vet op donkere vlakken onzichtbaar).
  const emph = new Map();
  let inspected = 0;
  for (const root of scopeAll) {
    for (const d of root.querySelectorAll('strong, b')) {
      if (++inspected > 300) break;
      if (!d.parentElement || !d.parentElement.closest('p, li') || !visible(d) || !(d.innerText || '').trim()) continue;
      const dcs = getComputedStyle(d), pcs = getComputedStyle(d.parentElement);
      const fg = parseColor(dcs.color), pc = parseColor(pcs.color);
      if (!fg || !pc) continue;
      const bg = effectiveBg(d);
      let code = null, why = '';
      if (bg && fg.a >= 0.5) {
        const l1 = lum(fg), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < 1.5) { code = 'nadruk_onzichtbaar'; why = `de vette tekst is bijna onzichtbaar (${dcs.color} op ${`rgb(${bg.r}, ${bg.g}, ${bg.b})`}, contrast ${R(ratio)}:1). Geef vet op dit vlak de kleur van de tekst eromheen.`; }
      }
      if (!code && sameColor(fg, pc) && isGrey(fg)) { code = 'nadruk_valt_niet_op'; why = `de nadruk heeft dezelfde grijze kleur (${dcs.color}) als de tekst eromheen en valt niet op. Geef vet een donkerdere kleur, bijvoorbeeld die van de koppen.`; }
      if (!code && sameColor(fg, pc) && Number(dcs.fontWeight) <= Number(pcs.fontWeight)) { code = 'nadruk_valt_niet_op'; why = `de nadruk is niet vetter dan de tekst eromheen (font-weight ${dcs.fontWeight} tegen ${pcs.fontWeight}) en valt niet op.`; }
      if (!code) continue;
      const key = code + '|' + why;
      if (emph.has(key)) emph.get(key).n++;
      else emph.set(key, { code, el: d, why, n: 1 });
    }
  }
  [...emph.values()].slice(0, 4).forEach((e) => add(e.code, `${label(e.el)}: ${e.why}${e.n > 1 ? ` (${e.n} keer)` : ''}`, { regel: 'Ontwerpbasis: nadruk moet opvallen' }));

  // Knoptekst over meer regels zonder binnenruimte boven en onder: de tekst raakt de rand.
  const lineCount = (el) => {
    const tops = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) tops.push(r.top);
    }
    tops.sort((a, b) => a - b);
    let lines = 0, last = -Infinity;
    for (const t of tops) { if (t - last > 4) { lines++; last = t; } }
    return lines;
  };
  const wrapSeen = new Set();
  for (const root of scopeAll) {
    for (const b of root.querySelectorAll(btnSel + ', a[class*="button"], a[class*="btn"], button')) {
      if (wrapSeen.has(b) || wrapSeen.size > 200 || !visible(b)) continue;
      wrapSeen.add(b);
      const bcs = getComputedStyle(b);
      const pt = px(bcs.paddingTop), pb = px(bcs.paddingBottom);
      if (pt + pb >= 4) continue;
      const lines = lineCount(b);
      if (lines >= 2) add('knoptekst_zonder_binnenruimte', `${label(b)}: de knoptekst loopt over ${lines} regels en heeft geen binnenruimte boven en onder (${pt} px en ${pb} px), zodat de tekst tegen de rand zit. Geef de knop binnenruimte (bijvoorbeeld padding: 12px 24px) of maak de tekst korter.`, { regel: 'Ontwerpbasis: binnenruimte boven en onder gelijk' });
    }
  }

  // Tikdoelen op mobiel (44 x 44 als uitgangspunt; links midden in lopende tekst tellen niet mee, zoals in WCAG 2.5.8).
  if (opts.mobile) {
    const small = [];
    const scope = measuredEls.length ? measuredEls : [document.querySelector('header') || document.body];
    for (const root of scope) {
      for (const d of root.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select, summary, [tabindex]:not([tabindex="-1"])')) {
        if (!visible(d)) continue;
        const dcs = getComputedStyle(d);
        if (dcs.display === 'inline' && d.closest('p, li') && d.tagName === 'A') continue;
        const r = d.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) small.push(`${label(d)} (${R(r.width)} x ${R(r.height)})`);
      }
    }
    if (small.length) add('tikdoel_klein', `${small.length} tikdoel(en) kleiner dan 44 x 44 px: ${small.slice(0, 5).join('; ')}${small.length > 5 ? '; ...' : ''}.`, { regel: 'WCAG 2.2 AAA 2.5.5 (44 px), minimaal AA 2.5.8 (24 px)' });
  }

  // Sinds 0.4.1 (besluit 175): pagina korter dan het scherm met een lege strook onder de footer.
  {
    const vh = window.innerHeight;
    const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const voeten = [...document.querySelectorAll('footer, .site-footer, [role=contentinfo]')].filter(visible);
    const voet = voeten.length ? voeten[voeten.length - 1] : null;
    if (voet && docH <= vh + 1) {
      const strook = R(vh - voet.getBoundingClientRect().bottom);
      if (strook > 8) add('lege_strook_onder_footer', `De pagina is korter dan het scherm: onder de footer staat een lege strook van ${strook} px (scherm ${vh} px hoog). Laat het laatste blok of de inhoud het scherm vullen, of zet de footer onderaan.`, { regel: 'Ontwerpbasis: geen lege strook onder de footer (besluit 175)' });
    }
  }

  // Lettergrootte per rol (sinds meetserver 0.4.0, besluit 177): per rol de voorkomende groottes, zodat de plugin
  // pagina's onderling en met het ontwerpprofiel kan vergelijken. Binnen één pagina: dezelfde rol in meer groottes
  // (alleen als de afwijkende grootte vaker dan één keer voorkomt of een kop is) melden.
  const ROLLEN = {
    h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4',
    broodtekst: 'main p, article p, .entry-content p, main li, .entry-content li',
    knop: btnSel,
    label: 'label',
    menu: 'nav a, [role=navigation] a, .menu a',
    footer: 'footer p, footer a, footer li, .site-footer p, .site-footer a',
  };
  const NAMEN = { h1: 'Kop H1', h2: 'Kop H2', h3: 'Kop H3', h4: 'Kop H4', broodtekst: 'Broodtekst', knop: 'Knoppen', label: 'Labels', menu: 'Menu', footer: 'Footer' };
  const lettergroottes = {};
  for (const [rol, sel] of Object.entries(ROLLEN)) {
    const tel = new Map();
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (++n > 400) break;
      if (!visible(el) || !(el.innerText || el.value || '').trim()) continue;
      if (rol === 'broodtekst' && el.closest('footer, nav, header, .site-footer, .site-header')) continue;
      if (rol === 'menu' && el.closest('footer, .site-footer')) continue;
      const fs = R(px(getComputedStyle(el).fontSize));
      if (!fs) continue;
      if (!tel.has(fs)) tel.set(fs, { aantal: 0, voorbeeld: label(el) });
      tel.get(fs).aantal++;
    }
    if (!tel.size) continue;
    const lijst = [...tel.entries()].map(([px_, v]) => ({ px: px_, aantal: v.aantal, voorbeeld: v.voorbeeld })).sort((a, b) => b.aantal - a.aantal);
    lettergroottes[rol] = lijst;
    const kop = /^h\d$/.test(rol);
    const afwijkend = lijst.slice(1).filter((g) => Math.abs(g.px - lijst[0].px) >= 1 && (kop || g.aantal >= 2) && !(rol === 'knop' || rol === 'footer'));
    if (afwijkend.length) {
      add('lettergrootte_wisselt', `${NAMEN[rol]} heeft op deze pagina meer groottes: ${lijst[0].px} px (${lijst[0].aantal} keer) en ${afwijkend.map((g) => `${g.px} px (${g.aantal} keer, bijv. ${g.voorbeeld})`).join(', ')}. Eén grootte per rol.`, { regel: 'Ontwerpbasis: één lettergrootte per rol (besluit 177)', rol });
    }
  }

  // Iconen in een rondje of knop (sinds meetserver 0.4.0, besluit 181): (a) een letterteken (+, −, ×, ›, ✓ …) als
  // icoon staat bijna nooit precies in het midden (de inkt van een teken zit niet midden in de regel); (b) een getekend
  // icoon (svg, span, ::before/::after) mag niet meer dan 1 px uit het midden van zijn rondje of knop staan.
  const TEKENS = /^[+\-−–×xX✕✖›‹»«<>✓✔→←↑↓▾▸▼▲⌄]$/u;
  const klein = (el) => { const r = el.getBoundingClientRect(); return r.width >= 8 && r.height >= 8 && r.width <= 64 && r.height <= 64; };
  const rondOfVak = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const rond = px(cs.borderTopLeftRadius) >= Math.min(r.width, r.height) * 0.4;
    const vlak = (parseColor(cs.backgroundColor) || { a: 0 }).a > 0.05 || px(cs.borderTopWidth) > 0;
    return (rond && vlak) || (vlak && Math.abs(r.width - r.height) <= 2) || el.matches('button, [role=button], summary');
  };
  const pseudoIcoon = (el, which) => {
    const ps = getComputedStyle(el, which);
    if (!ps || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') return null;
    return ps;
  };
  const icoonGezien = new Set();
  let icoonN = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++icoonN > 3000 || icoonGezien.size >= 6) break;
    if (!visible(el) || !klein(el) || !rondOfVak(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const tekst = (el.innerText || '').trim();
    let melding = null;
    // (a) letterteken als inhoud of als content van ::before/::after
    let teken = TEKENS.test(tekst) ? tekst : '';
    if (!teken) for (const w of ['::before', '::after']) {
      const ps = pseudoIcoon(el, w);
      const c = ps ? ps.content.replace(/^["']|["']$/g, '') : '';
      if (c && TEKENS.test(c)) { teken = c; break; }
    }
    if (teken) melding = `${label(el)}: het icoon is een letterteken ("${teken}"). Een teken staat bijna nooit precies in het midden van een rondje of knop. Teken het met CSS-streepjes of een SVG met een gecentreerde viewBox, in hele pixels.`;
    // (b) getekend icoon uit het midden
    if (!melding && !tekst) {
      let ir = null;
      const kind = el.querySelector('svg, img, i, span');
      if (kind && visible(kind) && el.children.length === 1) {
        if (kind.tagName.toLowerCase() === 'svg' && kind.getBBox) {
          try {
            const bb = kind.getBBox(), m = kind.getScreenCTM();
            if (m && bb.width > 0) { const a = new DOMPoint(bb.x, bb.y).matrixTransform(m), b = new DOMPoint(bb.x + bb.width, bb.y + bb.height).matrixTransform(m); ir = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }; }
          } catch (e) { ir = null; }
        }
        if (!ir) { const k = kind.getBoundingClientRect(); if (k.width > 0 && k.width < r.width) ir = k; }
      }
      if (ir) {
        const dx = R((ir.left + ir.right) / 2 - cx), dy = R((ir.top + ir.bottom) / 2 - cy);
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) melding = `${label(el)}: het icoon staat ${Math.abs(dx) > 1 ? `${Math.abs(dx)} px te ${dx > 0 ? 'rechts' : 'links'}` : ''}${Math.abs(dx) > 1 && Math.abs(dy) > 1 ? ' en ' : ''}${Math.abs(dy) > 1 ? `${Math.abs(dy)} px te ${dy > 0 ? 'laag' : 'hoog'}` : ''} in zijn rondje of knop.`;
      }
    }
    if (!melding) continue;
    const sel = label(el);
    if (icoonGezien.has(sel)) continue;
    icoonGezien.add(sel);
    add('icoon_niet_gecentreerd', melding, { regel: 'Ontwerpbasis: iconen exact gecentreerd, getekend en niet als letterteken (besluit 181)' });
  }

  // Sinds 0.4.2 (besluit 369): ankers (doel van een link als #wensgesprek) staan op de kop van de sectie, en een vaste
  // (sticky) kop mag de sectiekop na het springen niet bedekken.
  {
    const isKop = (el) => /^H[1-6]$/.test(el.tagName);
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="#"]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
      if (u.pathname !== location.pathname || !u.hash || u.hash.length < 2) continue;
      ids.add(decodeURIComponent(u.hash.slice(1)));
    }
    // Vaste kop bovenaan: positie fixed of sticky, bovenaan, minstens de halve schermbreedte, niet hoger dan 40% van het scherm.
    let vast = 0;
    for (const el of document.querySelectorAll('header, .site-header, [role=banner], .elementor-sticky, nav')) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (px(cs.top) <= 1 && r.width >= vw / 2 && r.height < window.innerHeight * 0.4) vast = Math.max(vast, R(r.height));
    }
    const padTop = px(getComputedStyle(document.documentElement).scrollPaddingTop);
    for (const id of ids) {
      const doel = document.getElementById(id);
      if (!doel || !visible(doel) || doel === document.body) continue;
      let kop = isKop(doel) ? doel : null;
      if (!kop) {
        const eerste = [...doel.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(visible);
        if (eerste && eerste.getBoundingClientRect().top - doel.getBoundingClientRect().top <= 100) kop = eerste;
      }
      if (!kop) {
        add('anker_niet_op_kop', `Anker #${id} staat op ${label(doel)}, niet op de kop van de sectie. Wie op de link klikt, komt onder de kop uit. Zet het id op de kop (of op de sectie met de kop bovenaan).`, { regel: "Ontwerpbasis: 'Ankers op de kop' (besluit 369)" });
        continue;
      }
      if (vast > 0) {
        const marge = px(getComputedStyle(doel).scrollMarginTop) + padTop;
        const verschil = R(vast - marge - (kop.getBoundingClientRect().top - doel.getBoundingClientRect().top));
        if (verschil > 1) add('kop_onder_vaste_kop', `Na springen naar #${id} valt de kop ${verschil} px onder de vaste kop van de site (${vast} px hoog). Zet scroll-margin-top: ${Math.ceil(vast)}px op het anker.`, { regel: "Ontwerpbasis: 'Ankers op de kop' (besluit 369)" });
      }
    }
  }

  return { schermbreedte: vw, paginabreedte: docW, standaardknop: standaardKnop, blokken: elements, meldingen: findings, lettergroottes };
}
