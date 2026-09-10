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

// ══ 6. two people on one listing ═════════════════════════════════════════
/* One deal brought by two is still one deal and one sum of money. Handing it
   to each of them in full is the failure this splits to avoid: the board then
   adds up to more money than ever came in, and "% of the pot" is nonsense. */
const patch = async o => {
  await page.evaluate(p => {
    const L = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
    Object.assign(L, p);
    localStorage.setItem('fourtis:ledger:v3', JSON.stringify(L));
  }, o);
  await page.reload({ waitUntil: 'load' });
  await unlock();
  await page.waitForTimeout(400);
};
const day = new Date().toISOString().slice(0, 10);
const pair = {
  id: 'pairdeal', brand, date: day, type: 'in', cat: 'Listing', pkg: 'Listing', chain: 'SOL',
  party: '$SPLIT', by: 'Michael, Shiller 1', amt: 1, tok: 'USDT', rate: 200, usd: 200,
  status: 'paid', paid: 200, mt: Date.now(),
  coms: [{ to: 'Michael', pct: 15, usd: 30, paid: false }, { to: 'Shiller 1', pct: 5, usd: 10, paid: false }]
};
await patch({ tx: [...S.tx, pair] });
await openShill();
await page.click('#pBody [data-sper="d"]'); await page.waitForTimeout(300);
const splitTxt = await page.locator('#pBody').innerText();
const rowOf = who => {
  const m = new RegExp(who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n([^\\n]*)\\n(-?\\$[\\d,.]+)').exec(splitTxt);
  return m ? { sub: m[1], amt: money(m[2]) } : null;
};
const mi = rowOf('Michael'), s1 = rowOf('Shiller 1');
check(!!mi && !!s1, `both names are on the board for one listing (${mi ? mi.amt : '?'} / ${s1 ? s1.amt : '?'})`);
check(mi && s1 && near(mi.amt + s1.amt, 200), `and their shares add back to the deal, not past it: ${mi.amt} + ${s1.amt}`);
check(mi && near(mi.amt, 150) && near(s1.amt, 50), `split follows the commission, 30:10 not 50:50: ${mi.amt} / ${s1.amt}`);
check(/1 listing/.test(splitTxt) && !/2 listings/.test(splitTxt), 'one listing is counted once, not once per name');
check(mi && /shared/.test(mi.sub), `the row says it was shared: "${mi.sub}"`);
await closePanel();

const actTxt = await page.locator('.row', { hasText: '$SPLIT' }).first().innerText();
check(/by Michael, Shiller 1/.test(actTxt), `the Activity row names who brought it: "${actTxt.replace(/\n/g, ' · ')}"`);
/* written as a subtraction: "+$200.00" with "fee $40" under it reads like two
   sums the deal earned, which is the misreading the minus removes */
check(/fee −\$40/.test(actTxt), `and the fee under it is a subtraction: "${(actTxt.match(/fee[^\n]*/) || [])[0]}"`);

// a part-paid listing keeps its fee too — that line used to lose it to the status
await patch({ tx: [...S.tx, { ...pair, id: 'dpdeal', party: '$PARTIAL', status: 'dp', paid: 80 }] });
const dpTxt = await page.locator('.row', { hasText: '$PARTIAL' }).first().innerText();
check(/of \$200/.test(dpTxt) && /fee −\$40/.test(dpTxt),
      `part-paid says both what landed and what the team takes: "${dpTxt.replace(/\n/g, ' · ')}"`);

// an even split when there is no commission to weigh them by
await patch({ tx: [...S.tx, { ...pair, id: 'evendeal', party: '$EVEN', coms: [] }] });
await openShill();
await page.click('#pBody [data-sper="d"]'); await page.waitForTimeout(300);
const evenTxt = await page.locator('#pBody').innerText();
const em = new RegExp('Michael\\n[^\\n]*\\n(-?\\$[\\d,.]+)').exec(evenTxt);
check(em && near(money(em[1]), 100), `no commission to weigh them by means an even split: ${em ? em[1] : '?'}`);
await closePanel();

// ══ 7. Added by fills the commission it implies ══════════════════════════
/* Naming the shiller and leaving the fee blank was the commonest way for a
   deal to end up with somebody credited and nothing owed to them. */
await patch({ tx: S.tx, team: [['Michael', 15], ['Shiller 1', 10], ['keya', 8], ['windy', 7]] });
await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on'); await page.waitForTimeout(250);
await page.fill('#fBy', 'keya');
await page.locator('#fParty').click();               // blur it, the way a thumb would
await page.waitForTimeout(300);
check(await page.locator('#acc').evaluate(e => e.open), 'the commission section opens itself, so the fee is seen');
check(await page.inputValue('#comRows [data-cf="to"]') === 'keya', 'a row is filled in for the person named');
check(await page.inputValue('#comRows [data-cf="pct"]') === '8', "at the default agreed with them (8%)");
await page.fill('#fAmt', '100'); await page.fill('#fRate', '1'); await page.waitForTimeout(250);
check(/8/.test(await page.locator('#comRows .cu').first().textContent()), 'and the USD follows the amount');

// two names in one box is one person to the app — it says so rather than guessing
await page.fill('#fBy', 'keya windy');
await page.locator('#fParty').click(); await page.waitForTimeout(300);
const byHint = (await page.locator('#byHint').textContent()).trim();
check(await page.locator('#byHint').isVisible() && /keya, windy/.test(byHint),
      `two names in one box is caught, not split on a guess: "${byHint}"`);
await page.click('#fX'); await page.waitForTimeout(200);

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
