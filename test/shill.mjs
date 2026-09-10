/* Cashfra shill-team test — what the team brought in, and what it cost.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/shill.mjs
 *
 * The card used to count one half of the arrangement. A team that brought in
 * $1,322 and was paid $1,500 for it read as $1,322 — a number with nothing
 * wrong on its face, and no way to tell from the screen that the month lost
 * money. So every check here is against the ledger's own arithmetic, not
 * against "a section rendered": the cost is rule 6's commission plus the
 * payments that never enter rule 6, and the point is that the two are added
 * once each.
 */
import { chromium, devices } from 'playwright';
import { stubFeed } from './stub-feed.mjs';
import { loadSample, consoleNoise } from './helpers.mjs';

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
page.on('console', m => { if (m.type() === 'error' && !consoleNoise(m)) bad.push('console: ' + m.text()); });

const unlock = async () => {
  await page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
  await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
};
const openShill = async () => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click('#pBody .mi[data-panel="shill"]');
  await page.waitForTimeout(350);
};
const closePanel = async () => {
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });
};
const money = s => Number(String(s).replace(/[^0-9.-]/g, ''));

await page.goto(BASE, { waitUntil: 'load' });
await unlock();
await loadSample(page);
await page.waitForTimeout(500);

// ── the ledger's own arithmetic, computed here rather than trusted ───────
const SHILL_PAY = ['Tip shiller', 'Blue-tick shiller', 'Team bonus', 'Premium team'];
const S = await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
const brand = S.brand;                              // the app opens on one brand
const month = new Date().toISOString().slice(0, 7);
const mine = S.tx.filter(t => (t.brand === brand || t.brand === '*') && t.date.slice(0, 7) === month);
const recv = t => t.type !== 'in' ? +t.usd : (t.status === 'unpaid' ? 0 : (t.status === 'dp' ? +t.paid : +t.usd));
const comv = t => t.type !== 'in' ? 0 : (t.coms || []).reduce((s, c) => s + (+c.usd || 0), 0);

/* rule 6's netting, per person: what a commission costs is the larger of what
   was accrued and what was actually paid out, never their sum */
const A = {}, P = {};
mine.forEach(t => {
  if (t.type === 'in') (t.coms || []).forEach(c => { if (+c.usd) A[c.to || '(no name)'] = (A[c.to || '(no name)'] || 0) + +c.usd; });
  else if (t.cat === 'Team commission') P[t.party || '(no name)'] = (P[t.party || '(no name)'] || 0) + +t.usd;
});
const gc = [...new Set([...Object.keys(A), ...Object.keys(P)])]
  .reduce((s, k) => s + Math.max(A[k] || 0, P[k] || 0), 0);
const direct = mine.filter(t => t.type === 'out' && SHILL_PAY.includes(t.cat))
  .reduce((s, t) => s + +t.usd, 0);
/* one recipient is unambiguous, two are a guess — the app credits only the first */
const broughtBy = t => {
  const v = String(t.by || '').trim(); if (v) return v;
  const c = (t.coms || []).filter(x => String(x.to || '').trim() && +x.usd > 0);
  return c.length === 1 ? String(c[0].to).trim() : '';
};
const brought = mine.filter(t => t.type === 'in' && broughtBy(t)).reduce((s, t) => s + recv(t), 0);
const cost = gc + direct;
const near = (a, b) => Math.abs(a - b) < 0.02;

check(direct > 0 && gc > 0, `the sample month has both kinds of team money (commission ${gc.toFixed(2)}, direct ${direct.toFixed(2)})`);

// ══ 1. the hero card ═════════════════════════════════════════════════════
const vShill = await page.locator('#vShill').textContent();
const dShill = await page.locator('#dShill').textContent();
check(near(money(vShill), brought - cost), `the card is the net, not the takings: ${vShill} (${brought.toFixed(2)} − ${cost.toFixed(2)})`);
check(!near(money(vShill), brought), `and it is not simply what they brought in (${brought.toFixed(2)})`);
const halves = dShill.match(/-?\$[\d,.]+/g) || [];
check(halves.length === 2, `the line under it carries both halves: "${dShill}"`);
check(near(money(halves[0]), brought) && near(money(halves[1]), cost),
      `and they are the two numbers the net came from: ${halves.join(' / ')}`);

// ══ 2. the panel behind it agrees ════════════════════════════════════════
await openShill();
const tot3 = await page.locator('#pBody .tot3 .v').allTextContents();
check(tot3.length === 3, `the panel opens on three figures: ${tot3.join(' · ')}`);
check(near(money(tot3[0]), brought), `brought in matches the ledger: ${tot3[0]}`);
check(near(money(tot3[1]), cost), `to the team matches the ledger: ${tot3[1]}`);
check(near(money(tot3[2]), brought - cost), `net is the difference, not a third number: ${tot3[2]}`);
const body = await page.locator('#pBody').innerText();
const noteM = body.match(/\$[\d,.]+ of that is commission(?:, \$[\d,.]+ paid directly)?/);
check(!!noteM, `it says what the cost is made of: "${noteM ? noteM[0] : '(missing)'}"`);
const parts = (noteM ? noteM[0].match(/\$[\d,.]+/g) : []) || [];
check(parts.length === 2 && near(money(parts[0]) + money(parts[1]), cost),
      `and the two parts add up to the whole, each counted once: ${parts.join(' + ')}`);
check(near(money(parts[0]), gc), `the commission part is rule 6's, not a second sum of it: ${parts[0]}`);

// ══ 3. the period switch moves the cost with the takings ═════════════════
await page.click('#pBody [data-sper="all"]'); await page.waitForTimeout(300);
const allTot = await page.locator('#pBody .tot3 .v').allTextContents();
const allDirect = S.tx.filter(t => (t.brand === brand || t.brand === '*') && t.type === 'out' && SHILL_PAY.includes(t.cat))
  .reduce((s, t) => s + +t.usd, 0);
check(allDirect > direct, `all-time reaches a payment this month does not (${allDirect.toFixed(2)} vs ${direct.toFixed(2)})`);
check(money(allTot[1]) > money(tot3[1]), `so All widens the cost too, not only the takings: ${allTot[1]} vs ${tot3[1]}`);
check(near(money(allTot[2]), money(allTot[0]) - money(allTot[1])), `and the net still holds: ${allTot[2]}`);

// ══ 4. a day with nothing credited still owns up to what was paid ════════
await page.click('#pBody [data-sper="d"]'); await page.waitForTimeout(300);
const dayTxt = await page.locator('#pBody').innerText();
const paidToday = mine.filter(t => t.type === 'out' && SHILL_PAY.includes(t.cat) && t.date === new Date().toISOString().slice(0, 10))
  .reduce((s, t) => s + +t.usd, 0);
check(/Nobody brought a listing|person|people/.test(dayTxt),
      'Day says plainly whether anyone is credited');
check(paidToday > 0.009 ? /Paid to the team anyway|To the team/.test(dayTxt) : true,
      'and money paid on a day with no listing is not left off the screen');
await closePanel();

// ══ 5. one person's page carries their own cost ══════════════════════════
await openShill();
await page.click('#pBody [data-sper="all"]'); await page.waitForTimeout(300);
const who = await page.locator('#pBody [data-shill]').first().getAttribute('data-shill');
await page.click(`#pBody [data-shill="${who}"]`); await page.waitForTimeout(350);
const one = await page.locator('#pBody').innerText();
check(/Kept after what they cost/.test(one), `${who}'s page states what is left after they are paid`);
/* against the ledger, not against two scraped rows: the point of the row is
   that all three ways money reaches this person are taken off, once each */
const theirs = S.tx.filter(t => (t.brand === brand || t.brand === '*') && t.type === 'in'
                             && broughtBy(t).toLowerCase() === who.toLowerCase());
const theirIn = theirs.reduce((s, t) => s + recv(t), 0);
const theirFee = theirs.reduce((s, t) => s + comv(t), 0);
const theirDirect = S.tx.filter(t => (t.brand === brand || t.brand === '*') && t.type === 'out'
      && SHILL_PAY.includes(t.cat) && String(t.party || '').trim().toLowerCase() === who.toLowerCase())
  .reduce((s, t) => s + +t.usd, 0);
const kept = money((one.match(/Kept after what they cost\s+(-?\$[\d,.]+)/) || [])[1] || 'x');
check(near(kept, theirIn - theirFee - theirDirect),
      `and the figure is right: ${kept} (${theirIn.toFixed(2)} in − ${theirFee.toFixed(2)} fee − ${theirDirect.toFixed(2)} direct)`);
check(theirFee > 0.009 && kept < theirIn, `it really is net of something (fee ${theirFee.toFixed(2)})`);

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
