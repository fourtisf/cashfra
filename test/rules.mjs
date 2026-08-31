/* Cashfra rules test — the three guards that keep the book honest.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/rules.mjs
 *
 * 1. A listing is cash in full, up front (CASHFRA-HANDOFF.md, rule 2).
 * 2. The same deal logged twice says so before it is saved.
 * 3. A client opens into their whole history.
 */
import { chromium, devices } from 'playwright';
import { stubFeed } from './stub-feed.mjs';
import { loadSample } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); process.exit(1); });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
await stubFeed(ctx);
const page = await ctx.newPage();
page.on('pageerror', e => bad.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') bad.push('console: ' + m.text()); });

const unlock = async () => {
  await page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
  await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
};
const openForm = async () => {
  await page.click('#addBtn2');
  await page.waitForSelector('#ovForm.on', { timeout: 3000 });
  await page.locator('#acc').evaluate(e => e.open = true);   // status lives under More details
};
const closeForm = async () => {
  await page.click('#fX');
  await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
};
const setCat = async label => {                    // options read "\u{1F680} Listing"
  const value = await page.locator('#fCat').evaluate((sel, l) => {
    const o = [...sel.options].find(x => x.textContent.trim().endsWith(l));
    return o && o.value;
  }, label);
  if (!value) throw new Error('no category option for ' + label);
  await page.selectOption('#fCat', value);
  await page.waitForTimeout(150);
};
const hidden = sel => page.locator(sel).evaluate(e => e.classList.contains('hide'));

await page.goto(BASE, { waitUntil: 'load' });
await unlock();
await loadSample(page);
await page.waitForTimeout(500);

// ══ 1. listings are cash, in full ════════════════════════════════════════
await openForm();
await setCat('Listing');
check(await page.locator('#fStat').inputValue() === 'paid',
      'a new listing starts as Paid in full');
check(await hidden('#cashWarn'), 'and says nothing while it stays that way');

await page.selectOption('#fStat', 'unpaid');
await page.waitForTimeout(150);
check(!(await hidden('#cashWarn')), 'marking a listing unpaid raises the cash-only warning');
const warn = (await page.locator('#cashWarn').textContent()).toLowerCase();
check(/no debt|no instalment/.test(warn), `the warning says why (${warn.slice(2, 60).trim()}…)`);

/* the rule is a warning, not a cage — it must not block the save */
await page.fill('#fAmt', '11');
await page.fill('#fParty', '$CASHRULE');
await page.locator('#fParty').blur();
await page.click('#fSave');
await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await page.waitForTimeout(500);                          // save() is debounced
const saved = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.find(t => t.party === '$CASHRULE'));
check(saved && saved.status === 'unpaid',
      'the warning explains, it does not block the save' +
      (saved && saved.status === 'unpaid' ? '' : ' — got ' + JSON.stringify(saved)));

// a line that really can be arranged differently keeps its freedom
await openForm();
await setCat('Trending');
await page.selectOption('#fStat', 'unpaid');
await page.waitForTimeout(150);
check(await hidden('#cashWarn'), 'trending can be unpaid with no warning — only listings are cash-only');
/* switching to a cash-only category resets the default, which is the point —
   it is the choice made after that which is answered with the warning */
await setCat('Xpress listing');
await page.waitForTimeout(150);
check(await page.locator('#fStat').inputValue() === 'paid',
      'switching to Xpress listing puts the status back to Paid in full');
await page.selectOption('#fStat', 'dp');
await page.waitForTimeout(150);
check(!(await hidden('#cashWarn')), 'an Xpress listing on a deposit warns too — no instalments');
check(await page.locator('#fStat').inputValue() === 'dp',
      'and the box keeps what was chosen rather than silently snapping back');
await closeForm();

// ══ 2. the same deal twice ═══════════════════════════════════════════════
const seed = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const t = S.tx.find(x => x.type === 'in' && x.party && x.brand === S.brand);
  return { party: t.party, amt: t.amt, date: t.date, tok: t.tok, cat: t.cat };
});
await openForm();
await page.click(`#toks [data-tok="${seed.tok}"]`);      // the match is amount AND coin
await page.fill('#fDate', seed.date);
await page.fill('#fAmt', String(seed.amt));
await page.fill('#fParty', seed.party);
await page.locator('#fParty').blur();
await page.waitForTimeout(250);
check(!(await hidden('#dupHint')), 'the same deal typed a second time is flagged before it is saved');
const dup = await page.locator('#dupHint').textContent();
check(dup.includes(seed.party), `the warning names the entry it matched (${dup.slice(2, 48).trim()}…)`);

await page.fill('#fAmt', String(Number(seed.amt) + 1));
await page.waitForTimeout(250);
check(await hidden('#dupHint'), 'a different amount is not a duplicate');
await page.fill('#fAmt', String(seed.amt));
await page.fill('#fParty', seed.party + 'X');
await page.locator('#fParty').blur();
await page.waitForTimeout(250);
check(await hidden('#dupHint'),
      'nor is a different client' + (await hidden('#dupHint') ? '' :
        ' — got: ' + (await page.locator('#dupHint').textContent())));
await closeForm();

/* editing an entry must not accuse it of being a copy of itself */
const anyId = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const now = new Date(), ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const t = S.tx.find(x => x.type === 'in' && x.party && x.brand === S.brand && x.date.startsWith(ym));
  return t && t.id;
});
if (anyId) {
  await page.click(`[data-ed="${anyId}"]`);
  await page.waitForSelector('#ovForm.on', { timeout: 3000 });
  await page.waitForTimeout(250);
  check(await hidden('#dupHint'), 'an entry being edited is never a duplicate of itself');
  await closeForm();
} else bad.push('no entry on screen to edit');

// ══ 3. opening a client ══════════════════════════════════════════════════
/* a repeat client, so the history below is more than one line */
await openForm();
await page.fill('#fAmt', '7');
await page.fill('#fParty', '$CASHRULE');
await page.locator('#fParty').blur();
await page.click('#fSave');
await page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await page.waitForTimeout(500);

await page.click('#moreBtn');
await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
await page.click('#pBody .mi[data-panel="cli"]');
await page.waitForTimeout(300);
/* the client who came back most often — one deal would prove nothing */
const who = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const n = {};
  S.tx.filter(t => t.type === 'in' && t.party && t.brand === S.brand)
      .forEach(t => n[t.party] = (n[t.party] || 0) + 1);
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
});
const row = page.locator(`#pBody [data-cli="${who}"]`);
check(await row.count() === 1, `the client list is there (${who})`);
await row.click();
await page.waitForTimeout(300);
check((await page.locator('#pTitle').textContent()) === who, 'clicking a client opens them by name');
check(!(await hidden('#pBack')), 'and a Back button appears');
const body = await page.locator('#pBody').textContent();
check(/Every deal/.test(body), 'their whole history is listed');
const rows = await page.locator('#pBody .sec').last().locator('.kv').count();
const deals = await page.evaluate(k => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  return S.tx.filter(t => t.type === 'in' && t.party === k && t.brand === S.brand).length;
}, who);
check(rows === deals, `every one of their deals is shown (${rows} of ${deals})`);

await page.click('#pBack');
await page.waitForTimeout(300);
check((await page.locator('#pBody [data-cli]').count()) > 0,
      'Back returns to the client list, not out of the panel');
check(await page.locator('#ovPanel').evaluate(e => e.classList.contains('on')), 'the panel is still open');
await page.click('#pBack');
await page.waitForTimeout(300);
check((await page.locator('#pTitle').textContent()) === 'Menu', 'a second Back goes to the menu');

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
