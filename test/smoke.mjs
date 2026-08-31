/* Cashfra smoke test — the regression walk from CASHFRA-HANDOFF.md, on a
 * phone viewport, plus everything the PWA hardening added.
 *
 *   python3 dev-server.py 8123 &
 *   node test/smoke.mjs
 *
 * BASE overrides the URL; CHROME_PATH overrides the browser binary. */
import { chromium, devices } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';
import { stubFeed, feedHits } from './stub-feed.mjs';
import { loadSample } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const unlock = async p => {
  await p.waitForSelector('#gate.on', { timeout: 5000 });
  for (const d of '162007') await p.click(`#gPad [data-k="${d}"]`);
  await p.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
/* the app checks live prices on unlock — stub the feed so the suite is hermetic */
await stubFeed(ctx);

const page = await ctx.newPage();

const errors = [], failed = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => {
  const u = r.url();
  if (u.startsWith(BASE)) failed.push(u + ' :: ' + r.failure()?.errorText);
});

await page.goto(BASE, { waitUntil: 'load' });

// ── every asset the head references actually resolves ─────────────────────
const links = await page.$$eval('link[href]', ls => ls.map(l => l.href));
for (const href of links) {
  const s = await page.evaluate(async u => (await fetch(u)).status, href);
  check(s === 200, `${href.replace(BASE, '/')} -> ${s}`);
}

// ── Chrome's own manifest parse (what the install prompt reads) ────────────
const cdp = await ctx.newCDPSession(page);
const appManifest = await cdp.send('Page.getAppManifest');
check((appManifest.errors || []).length === 0,
      `chrome manifest parse: ${JSON.stringify(appManifest.errors || [])}`);
const man = await page.evaluate(async u => (await fetch(u)).json(),
                                await page.$eval('link[rel=manifest]', l => l.href));
check(man.name === 'Cashfra' && man.display === 'standalone', 'manifest name + standalone display');
check(man.icons.some(i => i.sizes === '192x192' && i.purpose === 'any')
   && man.icons.some(i => i.sizes === '512x512' && i.purpose === 'any'), 'manifest has 192 + 512 any icons');
check(man.icons.some(i => i.purpose === 'maskable'), 'manifest has maskable icons');
for (const i of man.icons) {
  const s = await page.evaluate(async u => (await fetch(u)).status, new URL(i.src, BASE).href);
  check(s === 200, `manifest icon ${i.src} -> ${s}`);
}

// ── service worker ────────────────────────────────────────────────────────
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  await new Promise(r => setTimeout(r, 500));
  const names = await caches.keys();
  const keys = await (await caches.open(names[0])).keys();
  return { state: reg.active?.state, controlled: !!navigator.serviceWorker.controller,
           scope: reg.scope, names, urls: keys.map(k => new URL(k.url).pathname).sort() };
});
check(sw.state === 'activated', `sw activated (${sw.state})`);
check(sw.controlled, 'page controlled by the sw');
check(sw.names.length === 1 && /^cashfra-/.test(sw.names[0]), `single versioned cache: ${sw.names}`);
for (const p of ['/', '/index.html', '/manifest.json', '/favicon.ico',
                 '/icons/icon-192.png', '/icons/icon-512.png',
                 '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
                 '/icons/apple-touch-icon.png'])
  check(sw.urls.includes(p), `precached ${p}`);

// ── PIN gate + app boot ───────────────────────────────────────────────────
check(await page.locator('#gPad').isVisible(), 'pin pad shown');
await page.click('#gPad [data-k="9"]');
await page.click('#gPad [data-k="del"]');
await unlock(page);
check(await page.locator('#net').isVisible(), 'PIN 162007 unlocks and the app renders');
/* a real ledger starts empty — nothing is ever invented on first run */
const firstRun = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
check(firstRun.tx.length === 0 && firstRun.demo === false, `first run opens on an empty book (${firstRun.tx.length} entries)`);
await loadSample(page);
const seeded = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
check(seeded.demo === true && seeded.tx.length > 0, `sample data loads only when asked (${seeded.tx.length} entries)`);
const hits = await feedHits(page);
check(hits === 1, `price feed checked once on unlock (${hits}x)`);

// ── smoke-walk the panels ─────────────────────────────────────────────────
const openPanel = async () => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
};
const closePanel = async () => {
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'),
                             null, { timeout: 3000 });
};
for (const [key, label] of [['ins', 'Insights'], ['com', 'Commission'], ['cli', 'Clients'],
                            ['set', 'Settings'], ['data', 'Your data']]) {
  await openPanel();
  await page.click(`#pBody .mi[data-panel="${key}"]`);
  await page.waitForTimeout(250);
  const title = await page.locator('#pTitle').textContent();
  const body = (await page.locator('#pBody').innerText()).trim();
  check(body.length > 20, `${label} panel renders as "${title}" (${body.length} chars)`);
  await closePanel();
}
/* the hero Commission chip opens the same panel */
await page.click('.hc[data-panel="com"]');
await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
check(/commission/i.test(await page.locator('#pTitle').textContent()), 'hero chip opens Commission');
await closePanel();

// ── package & chain mix donuts ────────────────────────────────────────────
await openPanel();
await page.click('#pBody .mi[data-panel="ins"]');
await page.waitForTimeout(300);
check((await page.$$('#pBody .mixw svg')).length === 2, 'two donuts render (package + chain)');
check((await page.$$eval('#pBody .mixh', h => h.map(x => x.textContent.trim()))).join() === 'By package,By chain',
      'both mixes are labelled');
const periodRows = await page.$$eval('#pBody .mixr', rs => rs.map(r => ({
  name: r.querySelector('.nm2').childNodes[0].textContent.trim(),
  pct: r.querySelector('.pc').textContent.trim(),
  color: r.querySelector('.dot').style.background })));
check(periodRows.length >= 2, `mix legend lists every slice: ${periodRows.map(r => r.name + ' ' + r.pct).join(' | ')}`);
check(periodRows.every(r => /^\d+%$/.test(r.pct)), 'every slice carries a direct % label');
/* "history": all time must widen the picture without repainting anything */
const byName = Object.fromEntries(periodRows.map(r => [r.name, r.color]));
await page.click('#pBody [data-mix="all"]');
await page.waitForTimeout(250);
const allRows = await page.$$eval('#pBody .mixr', rs => rs.map(r => ({
  name: r.querySelector('.nm2').childNodes[0].textContent.trim(),
  color: r.querySelector('.dot').style.background })));
check(allRows.length >= periodRows.length, `all time widens the mix: ${periodRows.length} -> ${allRows.length} rows`);
check(allRows.filter(r => byName[r.name] && byName[r.name] !== r.color).length === 0,
      'colour follows the entity, not its rank — nothing repaints when the filter changes');
await closePanel();

// ── period toggle + navigation ────────────────────────────────────────────
const monthLbl = await page.locator('#mLbl').textContent();
await page.click('.hper [data-per="w"]');
await page.waitForTimeout(200);
const weekLbl = await page.locator('#mLbl').textContent();
check(monthLbl !== weekLbl, `M/W toggle switches period (${monthLbl} -> ${weekLbl})`);
await page.click('#prev'); await page.waitForTimeout(150);
await page.click('#next'); await page.waitForTimeout(150);
await page.click('.hper [data-per="m"]');
await page.waitForTimeout(200);
check((await page.locator('#mLbl').textContent()) === monthLbl, 'period nav returns to the same month');

// ── log a real entry ──────────────────────────────────────────────────────
const before = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.map(t => t.id));
await page.click('#addBtn2');
await page.waitForSelector('#ovForm.on', { timeout: 3000 });
await page.fill('#fAmt', '2.5 bnb');
await page.locator('#fAmt').blur();
await page.waitForTimeout(200);
await page.click('#fSave');
await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await page.waitForTimeout(600);   /* save() is debounced 250ms */
check(/^Saved/.test(await page.locator('#tMsg').textContent()),
      `save toast: ${await page.locator('#tMsg').textContent()}`);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx);
const fresh = after.filter(t => !before.includes(t.id));
check(fresh.length === 1, `one new entry saved (${fresh.length})`);
const e0 = fresh[0] || {};
check(e0.amt === 2.5 && e0.tok === 'BNB', `"2.5 bnb" parsed -> ${e0.amt} ${e0.tok}`);
check(e0.usd === +(e0.amt * e0.rate).toFixed(10), `usd locked at entry: ${e0.usd} = ${e0.amt} x ${e0.rate}`);
const txCount = after.length;

// ── offline relaunch ──────────────────────────────────────────────────────
await ctx.setOffline(true);
await page.goto(BASE, { waitUntil: 'load' });
check(await page.locator('#gate.on').isVisible(), 'offline relaunch serves the cached shell');
await unlock(page);
const offline = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.length);
check(offline === txCount, `ledger intact offline (${offline} entries)`);
check(/\$/.test(await page.locator('#net').textContent()), 'hero renders offline');
await page.screenshot({ path: process.env.SHOT || join(tmpdir(), 'cashfra-offline.png') });
await ctx.setOffline(false);

// ── nothing broke along the way ───────────────────────────────────────────
check(errors.length === 0, `console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
check(failed.length === 0, `failed same-origin requests: ${failed.length ? failed.join(' | ') : 'none'}`);

await browser.close();
console.log(ok.map(s => '  PASS  ' + s).join('\n'));
if (bad.length) { console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n')); process.exit(1); }
console.log(`\n${ok.length} checks passed`);
