/* Cashfra shared-cost and team-statement test.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/brands.mjs
 *
 * A cost that runs both books used to be dumped on whichever brand was on
 * screen, which is what made the brand table lie. And the Commission panel
 * knew what each person was owed but had nothing ALFA could send them.
 */
import { chromium, devices } from 'playwright';
import { stubFeed } from './stub-feed.mjs';
import { loadSample, consoleNoise, syncNoise } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); process.exit(1); });
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
/* the first money-looking token only — some cells carry a percentage after it */
const money = s => {
  const m = String(s).match(/-?\$?\s*-?[\d,]+(?:\.\d+)?/);
  return m ? Number(m[0].replace(/[^0-9.-]/g, '')) : NaN;
};

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
const viewBrand = async b => {                       // the brand switcher, via storage
  await page.evaluate(v => {
    const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
    S.brand = v; localStorage.setItem('fourtis:ledger:v3', JSON.stringify(S));
  }, b);
  await page.reload({ waitUntil: 'load' });
  await unlock();
  await page.waitForTimeout(300);
};
const openPanel = async key => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click(`#pBody .mi[data-panel="${key}"]`);
  await page.waitForTimeout(400);
};
const closePanel = async () => {
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });
};
const setCat = async label => {
  const v = await page.locator('#fCat').evaluate((sel, l) =>
    [...sel.options].find(o => o.textContent.trim().endsWith(l)).value, label);
  await page.selectOption('#fCat', v);
  await page.waitForTimeout(150);
};

await page.goto(BASE, { waitUntil: 'load' });
await unlock();
await loadSample(page);
await page.waitForTimeout(500);

// ══ 1. the Shared chip is offered where it makes sense ═══════════════════
await page.click('#addBtn2');
await page.waitForSelector('#ovForm.on', { timeout: 3000 });
check(!(await page.locator('#bpShared').isVisible()), 'money in is never shared — one deal, one brand');
await page.click('#seg [data-t="out"]');
await page.waitForTimeout(200);
check(await page.locator('#bpShared').isVisible(), 'a cost can be shared');
await setCat('Team commission');
check(!(await page.locator('#bpShared').isVisible()),
      'but commission cannot — it is earned on one deal under one brand');
await setCat('MongoDB');
check(await page.locator('#bpShared').isVisible(), 'and the chip comes back for a real shared cost');

await page.click('#bpShared');
await page.waitForTimeout(200);
check(await page.locator('#sharedHint').isVisible(), 'choosing it says what it will do');
await page.fill('#fAmt', '60');
await page.fill('#fRate', '1');
await page.fill('#fParty', 'MongoDB Atlas');
await page.click('#fSave');
await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await page.waitForTimeout(600);

const BILL = 60;
const stored = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.find(t => t.party === 'MongoDB Atlas' && t.usd === 60));
check(stored && stored.brand === '*', 'it is stored as belonging to no single brand');

/* what each brand brought in this period decides the split */
const shares = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const now = new Date(), ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const recv = t => t.status === 'unpaid' ? 0 : (t.status === 'dp' ? +t.paid || 0 : +t.usd || 0);
  const per = {}; let all = 0;
  S.tx.filter(t => t.type === 'in' && t.date.slice(0, 7) === ym).forEach(t => {
    const v = recv(t); all += v; per[t.brand] = (per[t.brand] || 0) + v;
  });
  const o = {}; S.brands.forEach(b => o[b] = all ? (per[b] || 0) / all : 1 / S.brands.length);
  return o;
});
const brands = Object.keys(shares);
check(brands.length === 2 && near(shares[brands[0]] + shares[brands[1]], 1),
      `the two brands' shares add to the whole (${brands.map(b => Math.round(shares[b] * 100) + '%').join(' / ')})`);

// ══ 2. each brand sees only its slice ════════════════════════════════════
const slice = {};
for (const b of brands) {
  await viewBrand(b);
  const row = page.locator('.row').filter({ hasText: 'MongoDB Atlas' }).first();
  check(await row.count() === 1, `${b} sees the shared cost at all`);
  const meta = await row.locator('.rs').textContent();
  check(/shared/.test(meta) && meta.includes(Math.round(shares[b] * 100) + '%'),
        `${b} is told it is shared and at what share (${meta.split('·').slice(0, 2).join('·').trim()})`);
  slice[b] = Math.abs(money(await row.locator('.a').textContent()));
  check(near(slice[b], BILL * shares[b], 0.05),
        `${b} carries ${slice[b]} of the ${BILL} bill, its ${Math.round(shares[b] * 100)}%`);
  check(/60 SOL/.test(meta), 'the bill itself is still shown whole — one payment was made, not a fraction');
}
check(near(slice[brands[0]] + slice[brands[1]], BILL, 0.05),
      `the two slices are the whole bill and no more (${slice[brands[0]]} + ${slice[brands[1]]})`);

await viewBrand('');
const wholeRow = page.locator('.row').filter({ hasText: 'MongoDB Atlas' }).first();
check(near(Math.abs(money(await wholeRow.locator('.a').textContent())), BILL),
      'with every brand on screen the whole bill shows, undivided');
check(/shared/.test(await wholeRow.locator('.rs').textContent()), 'still marked shared');

// ══ 3. the brand table, which is what this was for ═══════════════════════
await openPanel('ins');
const body = await page.textContent('#pBody');
check(/Shared costs/.test(body), 'Insights has a section for what the brands pay for together');
const sec = body.match(/Shared costs.*?Brand vs brand/s)[0];
check(sec.includes('Total shared') && sec.includes('$60.00'), 'it states the total');
for (const b of brands)
  check(sec.includes(Math.round(shares[b] * 100) + '% of the money in'),
        `and shows ${b}'s share of it`);

const tbl = await page.locator('#pBody .sec').filter({ hasText: 'Brand vs brand' }).first();
const shRow = tbl.locator('tr').filter({ hasText: 'of that, shared' });
check(await shRow.count() === 1, 'the table owns up to what is shared');
const cells = (await shRow.locator('td').allTextContents()).map(money);
check(near(cells[0] + cells[1], BILL, 0.05),
      `the shared halves in the table add back to the bill (${cells.join(' + ')})`);
const outRow = tbl.locator('tr').filter({ hasText: 'Money out' }).first();
const outs = (await outRow.locator('td').allTextContents()).map(money);
check(outs[0] > cells[0] - 0.01 && outs[1] > cells[1] - 0.01,
      'and each brand’s money out contains its slice');
await closePanel();

// ══ 4. the team statement ════════════════════════════════════════════════
await openPanel('com');
const names = await page.$$eval('#pBody [data-team]', els => els.map(e => e.dataset.team));
check(names.length > 0, `the commission panel lists people to open (${names.join(', ')})`);
const who = names[0];
const truth = await page.evaluate(k => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const n = k.trim().toLowerCase();
  let deals = 0, earned = 0, touched = 0, paid = 0, marked = 0;
  S.tx.forEach(t => {
    if (S.brand && t.brand !== S.brand && t.brand !== '*') return;
    if (t.type === 'in') (t.coms || []).forEach(c => {
      if (String(c.to || '(no name)').trim().toLowerCase() !== n || !+c.usd) return;
      deals++; earned += +c.usd; touched += +t.usd; if (c.paid) marked += +c.usd;
    });
    else if (t.cat === 'Team commission' && String(t.party || '').trim().toLowerCase() === n) paid += +t.usd;
  });
  const credit = Math.min(earned, Math.max(paid, marked));
  return { deals, earned, touched, paid, owed: Math.max(0, earned - credit) };
}, who);

await page.click(`#pBody [data-team="${who}"]`);
await page.waitForTimeout(400);
check((await page.locator('#pTitle').textContent()) === who, 'tapping a name opens their statement');
const st = await page.textContent('#pBody');
const tiles = await page.locator('#pBody .tot3 .v').allTextContents();
check(near(money(tiles[0]), truth.earned, 0.05), `earned matches the ledger (${tiles[0]})`);
check(near(money(tiles[2]), truth.owed, 0.05), `and so does what is still owed (${tiles[2]})`);
const rows = await page.locator('#pBody .sec').filter({ hasText: 'Every deal' }).locator('.kv').count();
check(rows === truth.deals, `every deal they earned on is listed (${rows} of ${truth.deals})`);
check(near(money(st.match(/Revenue they touched.*?\$([\d,.]+)/s)[1].replace(/,/g, '')), truth.touched, 0.05),
      'the revenue they touched is the deals they were on, not the whole book');
/* read the figure itself, not the "their default is 10%" line beneath it */
const eff = Number((await page.locator('#pBody .kv').filter({ hasText: 'Effective rate' })
                    .locator('.r b').textContent()).replace('%', ''));
check(near(eff, truth.earned / truth.touched * 100, 0.15),
      `the effective rate is what they actually charge, not what was agreed (${eff}%)`);
check(/pts vs default|as agreed|no default set/.test(st),
      'measured against what was agreed with them');

await page.click('#pBody [data-tcopy]');
await page.waitForTimeout(500);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.includes(who) && /Still owed/.test(clip), 'the statement copies as text he can send them');
check(clip.split('\n').length > truth.deals, 'with a line per deal, not just a total');

await page.click('#pBack');
await page.waitForTimeout(300);
check((await page.locator('#pBody [data-team]').count()) > 0, 'Back returns to the list of people');
await page.click('#pBack');
await page.waitForTimeout(300);
check((await page.locator('#pTitle').textContent()) === 'Menu', 'and a second Back leaves for the menu');

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
