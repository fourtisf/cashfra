/* Cashfra feature test — the six additions after the PWA work.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/features.mjs
 */
import { chromium, devices } from 'playwright';
import { stubFeed, feedDown } from './stub-feed.mjs';
import { loadSample, consoleNoise, syncNoise } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const DAY = 864e5;

const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); process.exit(1); });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['clipboard-read', 'clipboard-write'] });
await stubFeed(ctx);
const page = await ctx.newPage();
page.on('pageerror', e => bad.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !consoleNoise(m)) bad.push('console: ' + m.text()); });

const unlock = async () => {
  await page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
  await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
};
const patch = async o => {                      // edit the ledger, then reload
  await page.evaluate(p => {
    const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
    Object.assign(S, p);
    localStorage.setItem('fourtis:ledger:v3', JSON.stringify(S));
  }, o);
  await page.reload({ waitUntil: 'load' });
  await unlock();
  await page.waitForTimeout(300);
};
const openPanel = async key => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click(`#pBody .mi[data-panel="${key}"]`);
  await page.waitForTimeout(300);
};
const closePanel = async () => {
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });
};

await page.goto(BASE, { waitUntil: 'load' });
await unlock();
await loadSample(page);
await page.waitForTimeout(600);

// ══ 1. stale price hint ══════════════════════════════════════════════════
await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on');
await page.waitForTimeout(200);
check(await page.locator('#rateHint').isHidden(), 'fresh prices say nothing in the form');
await page.click('#fX'); await page.waitForTimeout(200);

/* a price only goes stale when the feed is actually failing, so fail it */
await feedDown(page, true);
await patch({ rateAt: Date.now() - 3 * DAY });
await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on');
await page.waitForTimeout(300);
const hint = (await page.locator('#rateHint').textContent()).trim();
check(await page.locator('#rateHint').isVisible() && /3 days ago/.test(hint), `feed down + old price is called out: "${hint}"`);
await feedDown(page, false);
await page.click('#rateHint [data-rate="now"]'); await page.waitForTimeout(900);
check(await page.locator('#rateHint').isHidden(), 'refreshing from the hint clears it');
check(await page.inputValue('#fRate') === '190', 'the refreshed price lands in the rate box');
await page.click('#fX'); await page.waitForTimeout(200);

// ══ 1b. sample data left by an earlier build is swept, once ══════════════
/* the state an older build produced: sample entries, untouched, no marker */
await patch({ seedFix: '', demo: true });
check((await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.length)) === 0,
      'sample entries seeded by an earlier build are cleared on first launch');
await loadSample(page);
await patch({ bkAt: Date.now() });
check((await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.length)) > 0,
      'and samples loaded on purpose afterwards survive a relaunch');
/* the sweep must never reach real work: demo is false the moment an entry is touched */
await patch({ seedFix: '', demo: false });
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.length);
check(kept > 0, `real entries are never swept (${kept} kept)`);

// ══ 2. backup reminder ═══════════════════════════════════════════════════
await patch({ demo: false, bkAt: 0 });   /* explicit: an earlier section set it */
let alert = await page.locator('#alert').innerText();
check(/No backup yet/.test(alert), `never-backed-up warns: "${(alert.match(/No backup yet[^\n]*/) || [''])[0]}"`);
await patch({ demo: false, bkAt: Date.now() - 20 * DAY });
alert = await page.locator('#alert').innerText();
check(/Last backup 20 days ago/.test(alert), 'a 20-day-old backup warns');
await patch({ demo: false, bkAt: Date.now() - 3 * DAY });
alert = await page.locator('#alert').innerText();
check(!/backup/i.test(alert), 'a 3-day-old backup stays quiet');

const dl = page.waitForEvent('download');
await patch({ demo: false, bkAt: 0 });
await page.click('#alert [data-bk]');
const file = await dl;
check(/^fourtis-backup-\d{4}-\d{2}-\d{2}\.json$/.test(file.suggestedFilename()), `backup downloads: ${file.suggestedFilename()}`);
await page.waitForTimeout(400);
check(await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).bkAt) > 0, 'backup date is recorded');
check(!/backup/i.test(await page.locator('#alert').innerText()), 'the notice clears once backed up');

/* hosted as an artifact the page is framed and <a download> is inert, so the
   viewer has to hand the file over — check we take that path when it exists */
await page.addInitScript(() => {
  window.__saved = [];
  window.claude = { use: n => Promise.resolve(n === 'downloads'
    ? Object.freeze({ save: r => { window.__saved.push(r.filename); return Promise.resolve({ status: 'saved' }); } })
    : null) };
});
await patch({ demo: false, bkAt: 0 });
await page.click('#alert [data-bk]');
await page.waitForTimeout(500);
const handed = await page.evaluate(() => window.__saved);
check(handed.length === 1 && /\.json$/.test(handed[0]),
      `where downloads are blocked, the file is handed to the viewer instead: ${handed.join(',')}`);
check(/Backup saved/.test(await page.locator('#tMsg').textContent()), 'and it confirms the save');
await page.addInitScript(() => { delete window.claude; });
await page.reload({ waitUntil: 'load' }); await unlock(); await page.waitForTimeout(200);

// ══ 2b. the app can say which build it is running ════════════════════════
await page.click('#moreBtn'); await page.waitForSelector('#ovPanel.on');
await page.click('#pBody .mi[data-panel="data"]'); await page.waitForTimeout(250);
const ver = await page.$$eval('#pBody .sec', secs => {
  const s = secs.find(x => /^Version$/i.test(x.querySelector('h3')?.textContent.trim() || ''));
  return s ? s.innerText.replace(/\s+/g, ' ').trim() : '';
});
const swBuild = await page.evaluate(async u => (await (await fetch(u)).text()).match(/var BUILD = '(.+)';/)[1], new URL('sw.js', BASE).href);
check(ver.includes(swBuild), `the app states its build, and it matches sw.js: "${ver.split('·')[0].trim()}" vs ${swBuild}`);
check(/offline-ready|not cached|no offline/.test(ver), `and whether the offline cache is live: "${ver}"`);
await page.click('#pClose');
await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });

// ══ 3. auto-lock ═════════════════════════════════════════════════════════
const hide = async () => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const show = async () => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const locked = () => page.evaluate(() => document.getElementById('gate').classList.contains('on'));
await hide(); await page.waitForTimeout(150);
check(await locked(), 'leaving the app covers the screen straight away');
await show(); await page.waitForTimeout(200);
check(!(await locked()), 'coming straight back does not ask for the code');

/* the grace period is real time, so drive the three settings rather than fake a clock */
await patch({ lockIdle: 0, demo: false, bkAt: Date.now() });
await hide(); await page.waitForTimeout(150);
await show(); await page.waitForTimeout(250);
check(await locked(), '"Immediately" asks for the code on every return');
await unlock();
check(!(await locked()), 'the code still opens it');

await patch({ lockIdle: -1, demo: false, bkAt: Date.now() });
await hide(); await page.waitForTimeout(150);
check(await locked(), '"Never" still covers the screen while the app is away');
await show(); await page.waitForTimeout(250);
check(!(await locked()), '"Never" does not ask for the code on return');
await patch({ lockIdle: 300, demo: false, bkAt: Date.now() });

// ══ 4. client contacts ═══════════════════════════════════════════════════
await openPanel('cli');
const first = page.locator('#pBody .ctc input').first();
await first.fill('@solcatdev');
await first.blur();
await page.waitForTimeout(300);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).contacts);
check(Object.values(saved).includes('@solcatdev'), `contact stored: ${JSON.stringify(saved)}`);
const links = await page.$$eval('#pBody .clnk', a => a.map(x => x.textContent.trim() + ' ' + x.getAttribute('href')));
check(links.some(l => l.includes('t.me/solcatdev')) && links.some(l => l.includes('x.com/solcatdev')),
      `@handle offers both: ${links.join(' | ')}`);
const url = page.locator('#pBody .ctc input').nth(1);
await url.fill('https://t.me/basedogchat'); await url.blur(); await page.waitForTimeout(300);
const links2 = await page.$$eval('#pBody .clnk', a => a.map(x => x.getAttribute('href')));
check(links2.includes('https://t.me/basedogchat'), 'a full URL becomes one Open link');
const txCheck = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.every(t => t.contact === undefined));
check(txCheck, 'the Entry shape is untouched — contacts live beside the ledger');
await closePanel();

// ══ 5. monthly target ════════════════════════════════════════════════════
check((await page.locator('#goal').innerText().catch(() => '')) === '', 'no target set, no card');
await patch({ goal: 500, demo: false, bkAt: Date.now() });
let goal = await page.locator('#goal').innerText();
check(/of \$500/.test(goal) && /%/.test(goal), `target card shows progress: "${goal.replace(/\n/g, ' ')}"`);
await page.click('.hper [data-per="w"]'); await page.waitForTimeout(250);
check((await page.locator('#goal').innerText()) === '', 'a monthly target is not shown in week view');
await page.click('.hper [data-per="m"]'); await page.waitForTimeout(250);
await patch({ goal: 50, demo: false, bkAt: Date.now() });
goal = await page.locator('#goal').innerText();
check(/🎉/.test(goal) || /100%|[0-9]{3}%/.test(goal), `a beaten target reads as beaten: "${goal.replace(/\n/g, ' ')}"`);
await patch({ goal: 3000, demo: false, bkAt: Date.now() });

// ══ 6. invoice / quotation ═══════════════════════════════════════════════
const unpaidId = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3'))
  .tx.filter(t => t.type === 'in' && t.status === 'unpaid')[0].id);
await patch({ wallets: [['BSC', '0xAbC1234567890dEf1234567890AbCdEf12345678']], goal: 3000, demo: false, bkAt: Date.now() });
await page.click(`[data-ed="${unpaidId}"]`);
await page.waitForSelector('#ovForm.on', { timeout: 3000 });
check(await page.locator('#fInv').isVisible(), 'an income entry offers an invoice');
await page.click('#fInv');
await page.waitForSelector('#ovInv.on', { timeout: 3000 });
check(await page.locator('#invTitle').textContent() === 'Quotation', 'an unpaid deal reads as a Quotation');
const doc = await page.locator('#invDoc').innerText();
check(/\$BNBWIF/.test(doc), 'the client is on it');
check(/0xAbC1234567890dEf1234567890AbCdEf12345678/.test(doc), 'the wallet for the deal\'s chain is on it');
check(/Amount due/.test(doc) && /\$603\.50/.test(doc), `the amount due is the headline: ${(doc.match(/Amount due[\s\S]{0,20}/) || [''])[0].replace(/\n/g, ' ')}`);
check(/[A-Z]{2,3}-\d{6}-[A-Z0-9]{4}/.test(doc), `it carries a stable document number: ${(doc.match(/[A-Z]{2,3}-\d{6}-[A-Z0-9]{4}/) || [''])[0]}`);
await page.click('#invCopy'); await page.waitForTimeout(500);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(/AMOUNT DUE/.test(clip) && /0xAbC1234/.test(clip), `copy gives pasteable text (${clip.split('\\n')[0]})`);
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
check(!(await page.locator('#ovInv').evaluate(e => e.classList.contains('on'))), 'Escape closes the invoice, not the form behind it');
check(await page.locator('#ovForm').evaluate(e => e.classList.contains('on')), 'the entry form is still open behind it');
await page.click('#fX'); await page.waitForTimeout(200);

/* has to be a settled deal in the month on screen, and in the brand on screen */
const paidId = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const now = new Date(), ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return S.tx.filter(t => t.type === 'in' && t.status === 'paid'
    && t.date.startsWith(ym) && t.brand === S.brand)[0].id;
});
await page.click(`[data-ed="${paidId}"]`); await page.waitForSelector('#ovForm.on');
await page.click('#fInv'); await page.waitForSelector('#ovInv.on');
check(await page.locator('#invTitle').textContent() === 'Invoice', 'a settled deal reads as an Invoice');
await page.screenshot({ path: process.env.SHOT || '/tmp/cashfra-invoice.png' });
await page.click('#invX'); await page.click('#fX');

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
