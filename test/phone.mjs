/* Cashfra on a phone — every screen fits on it, and no field makes iOS zoom.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/phone.mjs
 *
 * Both of these shipped, and neither shows on a desktop. Settings' price,
 * package and team rows came out 406px wide on every phone: a grid track will
 * not shrink below what an input asks for by default, so the ✕ on each row sat
 * off the screen. And on ALFA's iPhone the entry form sat zoomed in and cut off
 * at both sides — iOS zooms into any field whose text is under 16px, and its
 * date field came out wider than the fields above it.
 *
 * The iOS half cannot run on iOS here, so it does the next best thing: it lifts
 * the rules out of the iOS-only block, applies them in Chromium, and asks what
 * they would do — every field at 16px or more, and not one box a pixel bigger
 * than the approved layout.
 */
import { chromium } from 'playwright';
import { stubFeed } from './stub-feed.mjs';
import { loadSample, consoleNoise } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
/* the narrowest phone the layout is held to, and ALFA's iPhone */
const WIDTHS = [320, 390];

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

/* Everything a screen needs answered, measured inside its scroller: is it
   wider than the screen, does anything poke past the side padding (2px is the
   bleed .tbl takes on purpose), and every field in it with its text size and
   box. A row inside its own sideways scroller (.toks, .tbl) is that
   scroller's business, not the sheet's. */
const measure = (page, sel) => page.evaluate(sel => {
  const box = sel === 'doc' ? document.documentElement : document.querySelector(sel);
  const scroller = sel === 'doc' ? document.querySelector('.app') : box;
  const r = scroller.getBoundingClientRect(), cs = getComputedStyle(scroller);
  const L = r.left + parseFloat(cs.paddingLeft) - 2, R = r.right - parseFloat(cs.paddingRight) + 2;
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const ownScroller = el => {
    for (let p = el.parentElement; p && p !== scroller; p = p.parentElement)
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    return false;
  };
  const poke = [], fields = [];
  for (const el of scroller.querySelectorAll('*')) {
    if (!el.getClientRects().length) continue;
    const e = el.getBoundingClientRect();
    if (e.width && (e.right > R || e.left < L) && !ownScroller(el))
      poke.push(`${name(el)} ${Math.round(e.left)}–${Math.round(e.right)}`);
    const text = el.matches('select,textarea,input:not([type=checkbox],[type=radio],[type=file],[type=hidden],[type=range],[type=color],[type=button],[type=submit],[type=reset],[type=image])');
    if (text) fields.push({ f: name(el), fs: parseFloat(getComputedStyle(el).fontSize), w: e.width, h: e.height });
  }
  return { sw: box.scrollWidth, cw: box.clientWidth, poke, fields };
}, sel);

/* Chromium has no -webkit-touch-callout, so the iOS block never applies in
   it. Copy its rules into a sheet of their own and it does. */
const IOS_ON = () => {
  let css = '';
  for (const sh of document.styleSheets) for (const r of sh.cssRules)
    if (r instanceof CSSSupportsRule && /-webkit-touch-callout/.test(r.conditionText))
      for (const x of r.cssRules) css += x.cssText + '\n';
  const s = document.createElement('style');
  s.id = 'asIfIOS'; s.textContent = css;
  document.head.appendChild(s);
  return css;
};
const IOS_OFF = () => document.getElementById('asIfIOS').remove();

for (const W of WIDTHS) {
  const ctx = await b.newContext({ viewport: { width: W, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await stubFeed(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !consoleNoise(m)) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#gate.on');
  for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
  await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'));
  await loadSample(page);

  const settle = () => page.waitForTimeout(450);   // the More-details chevron turns for .2s
  const openAll = sel => page.evaluate(sel => document.querySelectorAll(sel + ' details').forEach(d => { d.open = true; }), sel);
  const menu = async k => {
    await page.click('#moreBtn');
    await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
    if (k) await page.click(`#pBody .mi[data-panel="${k}"]`);
    await settle(); await openAll('#pBody');
  };
  const closePanel = async () => {
    await page.click('#pClose');
    await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });
  };
  const closeForm = async () => {
    await page.click('#fX');
    await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
  };
  const deal = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3'))
    .tx.find(t => t.type === 'in' && (t.coms || []).length > 1).id);

  /* every screen, how to reach it, the box that scrolls, and the way back */
  const screens = [
    ['home', async () => {}, 'doc', async () => {}],
    ['new entry · money in', async () => {
      await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on');
      await openAll('#ovForm'); await settle();
    }, '#ovForm .sbody', closeForm],
    ['new entry · money out', async () => {
      await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on');
      await page.click('#seg [data-t="out"]'); await openAll('#ovForm'); await settle();
    }, '#ovForm .sbody', closeForm],
    ['a deal with two commission lines', async () => {
      await page.click(`[data-ed="${deal}"]`); await page.waitForSelector('#ovForm.on');
      await openAll('#ovForm'); await settle();
    }, '#ovForm .sbody', async () => {}],
    ['its invoice', async () => {
      await page.click('#fInv'); await page.waitForSelector('#ovInv.on'); await settle();
    }, '#ovInv .sbody', async () => {
      await page.click('#invX'); await settle(); await closeForm();
    }],
    ['brands, adding one', async () => {
      await page.click('#brandBtn'); await page.waitForSelector('#ovBrand.on');
      await page.click('#bBody [data-braddui]'); await settle();
    }, '#bBody', async () => { await page.click('#bX'); await settle(); }],
    ['menu', () => menu(''), '#pBody', closePanel],
    ...[['ins', 'Insights'], ['mix', 'Package & chain'], ['com', 'Commission'], ['cli', 'Clients'],
        ['shill', 'Shill team'], ['set', 'Settings'], ['data', 'Your data']]
      .map(([k, label]) => [label, () => menu(k), '#pBody', closePanel]),
    ['one person\'s statement', async () => {
      await menu('com'); await page.click('#pBody [data-team]'); await settle(); await openAll('#pBody');
    }, '#pBody', closePanel],
    ['one client', async () => {
      await menu('cli'); await page.click('#pBody [data-cli]'); await settle(); await openAll('#pBody');
    }, '#pBody', closePanel],
    ['one shiller\'s record', async () => {
      await menu('shill'); await page.click('#pBody [data-shill]'); await settle(); await openAll('#pBody');
    }, '#pBody', closePanel],
  ];

  let fieldsSeen = 0;
  for (const [label, open, sel, close] of screens) {
    await open();
    const m = await measure(page, sel);
    check(m.sw <= m.cw && !m.poke.length,
      `${W}px · ${label} fits the screen (${m.sw}/${m.cw}px)${m.poke.length ? ' — past the edge: ' + m.poke.slice(0, 4).join(', ') : ''}`);

    /* the iOS half: only where there are fields, and only once — font sizes
       and boxes do not depend on how wide the phone is */
    if (W === WIDTHS[WIDTHS.length - 1] && m.fields.length) {
      await page.evaluate(IOS_ON);
      const ios = await measure(page, sel);
      await page.evaluate(IOS_OFF);
      fieldsSeen += ios.fields.length;
      const small = ios.fields.filter(f => f.fs < 16);
      check(!small.length, `iOS · ${label}: no field under 16px, so tapping one does not zoom the page` +
        (small.length ? ' — ' + small.map(f => `${f.f} ${f.fs}px`).join(', ') : ` (${ios.fields.length} fields)`));
      /* a text box keeps its line, so it may not move at all; a select sizes
         from its font in Chromium whatever the line says, so 14.5px → 16px
         lets it grow that much taller, never wider */
      const moved = ios.fields.filter((f, i) => Math.abs(f.w - m.fields[i].w) > .5 ||
        (/^select/.test(f.f) ? f.h - m.fields[i].h > 4 || f.h < m.fields[i].h - .5 : Math.abs(f.h - m.fields[i].h) > .5));
      check(ios.fields.length === m.fields.length && !moved.length, `iOS · ${label}: and no box moves` +
        (moved.length ? ' — ' + moved.map(f => { const o = m.fields[ios.fields.indexOf(f)];
          return `${f.f} ${o.w.toFixed(1)}×${o.h.toFixed(1)} → ${f.w.toFixed(1)}×${f.h.toFixed(1)}`; }).join(', ') : ''));
      check(ios.sw <= ios.cw && !ios.poke.length, `iOS · ${label}: and it still fits`);
    }
    await close();
  }
  check(!errors.length, `${W}px · no console errors (${errors.slice(0, 3).join(' | ')})`);

  if (W !== WIDTHS[WIDTHS.length - 1]) { await ctx.close(); continue; }

  // ── the iOS block itself ──────────────────────────────────────────────────
  check(fieldsSeen >= 20, `the walk reached the fields it is meant to (${fieldsSeen})`);
  await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on');
  const off = await page.evaluate(() => ['fParty', 'fRate', 'q'].map(id =>
    getComputedStyle(document.getElementById(id)).fontSize));
  /* Chromium is Android and the desktop: the block must not reach them */
  check(off.join() === '14.5px,13px,13.5px', `off iOS the approved field sizes stand (${off.join(', ')})`);
  const css = await page.evaluate(IOS_ON);
  const app = await page.evaluate(() => getComputedStyle(document.getElementById('fDate')).appearance);
  await page.evaluate(IOS_OFF);
  check(css.split('\n').filter(Boolean).length >= 5, 'the iOS-only block is there and has rules in it');
  /* WebKit forces content-box and its own padding on a date field left
     native; that is what made it wider than the rest on the iPhone. Its box
     past that is iOS's own shadow tree, which Chromium does not have — so
     this asks only that the rule reaches the field. */
  check(app === 'none', `iOS · the date field drops the native look WebKit resizes (${app})`);
  check(/::-webkit-date-and-time-value[^{]*\{[^}]*text-align: left/.test(css),
    'iOS · its date reads from the left like every other field, not centred');
  await closeForm();

  /* the zoom is fixed by making it unnecessary, not by forbidding it */
  const vp = await page.getAttribute('meta[name=viewport]', 'content');
  check(!/maximum-scale|user-scalable\s*=\s*(no|0)/i.test(vp), `pinch zoom is left alone (${vp})`);
  await ctx.close();
}

await b.close();
for (const m of ok) console.log('  PASS  ' + m);
for (const m of bad) console.log('  FAIL  ' + m);
console.log(`\n${ok.length} checks passed${bad.length ? `, ${bad.length} FAILED` : ''}`);
process.exit(bad.length ? 1 : 0);
