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
/* Who brought a listing is read off the commission on it, and nothing else.
   Two names share it, split by what each earned. */
const fees = t => {
  const by = {}; let sum = 0;
  (t.coms || []).forEach(c => {
    const n = String(c.to || '').trim(), v = +c.usd || 0;
    if (!n || v <= 0) return;
    by[n.toLowerCase()] = (by[n.toLowerCase()] || 0) + v; sum += v;
  });
  return { by, sum };
};
const credited = t => t.type === 'in' && fees(t).sum > 0;
const shareOf = (t, who) => { const f = fees(t); return f.sum > 0 ? (f.by[who.toLowerCase()] || 0) / f.sum : 0; };
const brought = mine.filter(credited).reduce((s, t) => s + recv(t), 0);
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
/* a dollar of slack, not a cent: above $1,000 the card drops the decimals,
   so the three figures are read back rounded and cannot reconcile exactly */
check(Math.abs(money(allTot[2]) - (money(allTot[0]) - money(allTot[1]))) < 1,
      `and the net still holds: ${allTot[0]} − ${allTot[1]} = ${allTot[2]}`);

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
const theirs = S.tx.filter(t => (t.brand === brand || t.brand === '*') && credited(t)
                             && shareOf(t, who) > 0);
const theirIn = theirs.reduce((s, t) => s + recv(t) * shareOf(t, who), 0);
const theirFee = theirs.reduce((s, t) => s + (fees(t).by[who.toLowerCase()] || 0), 0);
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
  party: '$SPLIT', amt: 1, tok: 'USDT', rate: 200, usd: 200,
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
check(/by Michael 15%, Shiller 1 5%/.test(actTxt), `the Activity row names who brought it, and what each is on: "${actTxt.replace(/\n/g, ' · ')}"`);
/* 30 and 10 off the same $200, not 20 and 20 — a split the row used to hide
   behind two bare names, and the one number a shiller checks first. */
check(!/by Michael 10%, Shiller 1 10%/.test(actTxt), 'the two rates are the split, not the average of it');
/* written as a subtraction: "+$200.00" with "fee $40" under it reads like two
   sums the deal earned, which is the misreading the minus removes */
check(/fee −\$40/.test(actTxt), `and the fee under it is a subtraction: "${(actTxt.match(/fee[^\n]*/) || [])[0]}"`);
/* 30 + 10 off a $200 deal — the rate, so the size of the cut is readable
   without doing the division in your head */
check(/fee −\$40\.00 · 20%/.test(actTxt), 'and carries the rate it works out at');

/* Both halves have to fit on one row of a phone. The meta line is a <span>,
   and overflow/text-overflow do nothing to an inline box — so it never
   clipped: it ran on under the fee on the right and the two read as one
   mangled line. Measured, because it renders as ordinary text either way. */
const clipped = await page.locator('.row', { hasText: '$SPLIT' }).first().evaluate(el => {
  const rs = el.querySelector('.rs'), rv = el.querySelector('.rv');
  return { over: rs.getBoundingClientRect().right - rv.getBoundingClientRect().left, ell: getComputedStyle(rs).display };
});
check(clipped.over <= 0.5, `the meta line stops at its own column instead of running under the fee (${clipped.over.toFixed(1)}px past it)`);
check(clipped.ell !== 'inline', `and is a block, so the ellipsis it relies on can happen at all (display: ${clipped.ell})`);

// a part-paid listing keeps its fee too — that line used to lose it to the status
await patch({ tx: [...S.tx, { ...pair, id: 'dpdeal', party: '$PARTIAL', status: 'dp', paid: 80 }] });
const dpTxt = await page.locator('.row', { hasText: '$PARTIAL' }).first().innerText();
check(/of \$200/.test(dpTxt) && /fee −\$40/.test(dpTxt),
      `part-paid says both what landed and what the team takes: "${dpTxt.replace(/\n/g, ' · ')}"`);

/* No commission means nobody worked it as far as the book is concerned, so
   the deal is uncredited rather than credited to a guess. */
await patch({ tx: [...S.tx, { ...pair, id: 'evendeal', party: '$EVEN', coms: [] }] });
await openShill();
await page.click('#pBody [data-sper="d"]'); await page.waitForTimeout(300);
const evenTxt = await page.locator('#pBody').innerText();
check(/Not credited to anyone|Nobody brought a listing/.test(evenTxt),
      'a listing with no commission is not credited to anyone');
check(!/Michael/.test(evenTxt), 'and nobody is invented for it');
await closePanel();

// ══ 7. the commission row is the whole of it ════════════════════════════
/* There was an `Added by` field beside the commission and it was the same
   people typed twice — credited without a fee, or paid without the credit,
   depending which of the two you filled. It is gone: a name with money
   against it is credited, and that is the only rule. */
await patch({ tx: S.tx, team: [['Michael', 15], ['Shiller 1', 10], ['keya', 8], ['windy', 7]] });
check(await page.locator('#fBy').count() === 0, 'the second place to name a shiller is gone from the form');
await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on'); await page.waitForTimeout(250);
await page.fill('#fAmt', '100'); await page.fill('#fRate', '1');
await page.locator('#acc').evaluate(e => { e.open = true; });
await page.click('#comAdd'); await page.waitForTimeout(200);
await page.locator('#comRows [data-cf="to"]').first().fill('keya');
await page.locator('#comRows [data-cf="to"]').first().dispatchEvent('input');
await page.waitForTimeout(250);
check(await page.locator('#comRows [data-cf="pct"]').first().inputValue() === '8',
      'typing a team name still brings their default % with it');
check(/8/.test(await page.locator('#comRows .cu').first().textContent()), 'and the USD follows the amount');

// ── a minus typed into a % cancels the fee, silently, unless it is refused ──
/* 10 and -10 across two people sum to nothing: the entry saves with no fee
   and reads in the ledger exactly like a deal that never had one. */
await page.click('#fX'); await page.waitForTimeout(200);          // a clean form
await page.click('#addBtn2'); await page.waitForSelector('#ovForm.on'); await page.waitForTimeout(250);
await page.fill('#fAmt', '100'); await page.fill('#fRate', '1');
await page.locator('#acc').evaluate(e => { e.open = true; });
for (const who of ['keya', 'windy']) {
  await page.click('#comAdd'); await page.waitForTimeout(150);
  const last = page.locator('#comRows [data-cf="to"]').last();
  await last.fill(who); await last.dispatchEvent('input'); await page.waitForTimeout(150);
}
const pctFields = page.locator('#comRows [data-cf="pct"]');
await pctFields.nth(0).fill('10');
await pctFields.nth(1).fill('-10');
await page.locator('#fAmt').click(); await page.waitForTimeout(250);
const cus = await page.locator('#comRows .cu').evaluateAll(e => e.map(x => [x.textContent.trim(), x.className]));
check(/bad/.test(cus[1][1]) && !/bad/.test(cus[0][1]),
      `the negative one is called out where it is typed (${cus.map(c => c[0]).join(' / ')})`);
await page.fill('#fParty', '$NEGFEE');
await page.click('#fSave'); await page.waitForTimeout(400);
check(await page.locator('#ovForm').evaluate(e => e.classList.contains('on')),
      'saving is refused rather than quietly booking a deal with no fee');
check(/cannot be negative/.test(await page.locator('#toast').textContent()),
      `and says why: "${(await page.locator('#toast').textContent()).trim()}"`);
await pctFields.nth(1).fill('10');
await page.locator('#fAmt').click(); await page.waitForTimeout(250);
await page.click('#fSave'); await page.waitForTimeout(500);
check(!await page.locator('#ovForm').evaluate(e => e.classList.contains('on')),
      'and saves once the minus is gone');
const negRow = await page.locator('.row', { hasText: '$NEGFEE' }).first().innerText();
check(/fee −\$20\.00 · 20%/.test(negRow), `both halves of the fee land: "${(negRow.match(/fee[^\n]*/) || [])[0]}"`);

/* Two people on one deal is now two commission rows and nothing else to get
   wrong — no box to type both names into, no separator to remember. */
const twoNames = await page.locator('.row', { hasText: '$NEGFEE' }).first().innerText();
check(/by keya 10%, windy 10%/.test(twoNames), `two rows read as two people on 10% each: "${twoNames.replace(/\n/g, ' · ')}"`);

// ══ 8. a negative that is already in the book ═══════════════════════════
/* commit() refuses one on save now, but entries logged before that rule
   still carry them — and nothing stopped the ledger from rendering one.
   comv() summed raw, so 10% and -10% cancelled to zero and the row showed no
   fee at all, while the Commission chip, the Shill team screen and Net —
   which have always read a negative as nothing — said $14.84. One entry with
   two answers to what the team cost, and the row was the one that looked
   like a deal nobody was owed anything on. */
const legacy = {
  id: 'legacyneg', brand, date: day, type: 'in', cat: 'Listing', pkg: 'Listing', chain: 'ETH',
  party: '$LEGACYNEG', amt: 0.06, tok: 'ETH', rate: 2473.83, usd: 148.43,
  status: 'paid', paid: 148.43, mt: Date.now(),
  coms: [{ to: 'keya', pct: 10, usd: 14.84, paid: false }, { to: 'windy', pct: -10, usd: -14.84, paid: false }]
};
await patch({ tx: [legacy] });
const legRow = await page.locator('.row', { hasText: '$LEGACYNEG' }).first().innerText();
check(/fee −\$14\.84/.test(legRow),
      `the negative counts as nothing instead of cancelling the fee: "${(legRow.match(/fee −[^\n]*/) || ['no fee line at all'])[0]}"`);

/* and the two screens agree on it, which is the whole point of the change */
const chipTxt = await page.locator('.hchips').innerText();
const chipCom = money((/Commission\n(\$[\d,.]+)/.exec(chipTxt) || [])[1] || '0');
const rowFee = money((/fee −(\$[\d,.]+)/.exec(legRow) || [])[1] || '0');
check(near(chipCom, rowFee), `the row and the Commission chip say the same number (${rowFee} / ${chipCom})`);

/* Somebody on a negative is credited with nothing, so broughtList drops them
   — and the row then read as one person when two were on the listing. */
check(/by keya 10%, windy −10%/.test(legRow),
      `both people are named, not only the one who earned: "${legRow.replace(/\n/g, ' · ')}"`);
check(/fee error/.test(legRow), 'and the entry is flagged rather than left looking ordinary');

/* An ordinary listing must not pick up the flag. */
await patch({ tx: [legacy, { ...legacy, id: 'okdeal', party: '$OKFEE', coms: [{ to: 'keya', pct: 10, usd: 14.84, paid: false }] }] });
const okRow = await page.locator('.row', { hasText: '$OKFEE' }).first().innerText();
check(!/fee error/.test(okRow) && /fee −\$14\.84/.test(okRow),
      `a clean listing is untouched by it: "${okRow.replace(/\n/g, ' · ')}"`);

// ══ 9. finding them without having to scroll for them ═══════════════════
/* The red pill only finds you if you scroll to it, and a fee error two
   months back is one nobody scrolls to. Said once at the top for the whole
   book instead — and the button goes to the field. It does not guess a
   number on ALFA's behalf: only he knows whether windy was on 10% or on
   nothing at all. */
const older = { ...legacy, id: 'oldneg', date: '2026-03-14', party: '$OLDNEG',
  coms: [{ to: 'keya', pct: -5, usd: -7.42, paid: false }] };
await patch({ tx: [legacy, older] });
const alertTxt = await page.locator('#alert').innerText();
check(/2 listings have a commission below zero/.test(alertTxt),
      `both are counted at the top, whichever month they sit in: "${alertTxt.replace(/\n/g, ' | ')}"`);

await page.click('#alert [data-fixfee]');
await page.waitForTimeout(600);
check(await page.locator('#ovForm').evaluate(e => e.classList.contains('on')), 'Fix opens the entry itself');
const focused = await page.evaluate(() => {
  const a = document.activeElement;
  return a ? { ci: a.dataset.ci, cf: a.dataset.cf, v: a.value } : {};
});
check(focused.cf === 'pct' && Number(focused.v) < 0,
      `with the cursor on the number that is wrong, not on the amount (${JSON.stringify(focused)})`);

await page.locator(`#comRows [data-ci="${focused.ci}"][data-cf="pct"]`).fill('10');
await page.locator('#fAmt').click(); await page.waitForTimeout(250);
await page.click('#fSave'); await page.waitForTimeout(600);
check(/1 listing has a commission below zero/.test(await page.locator('#alert').innerText()),
      'and the notice counts down as they are put right');

/* the one left is in March, and the period on screen is not March */
await page.click('#alert [data-fixfee]');
await page.waitForTimeout(700);
const gotDate = await page.locator('#fDate').inputValue();
check(gotDate === '2026-03-14', `Fix travels to an entry outside the period on screen (${gotDate})`);
await page.locator('#comRows [data-cf="pct"]').first().fill('5');
await page.locator('#fAmt').click(); await page.waitForTimeout(250);
await page.click('#fSave'); await page.waitForTimeout(600);
check(!/below zero/.test(await page.locator('#alert').innerText()),
      'and it is gone once the book is clean');

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
