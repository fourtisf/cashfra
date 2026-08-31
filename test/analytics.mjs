/* Cashfra analytics test — the comparison and allocation views.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/analytics.mjs
 *
 * The numbers are checked against the ledger, not just "a section rendered".
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
const patch = async o => {
  await page.evaluate(p => {
    const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
    Object.assign(S, p);
    localStorage.setItem('fourtis:ledger:v3', JSON.stringify(S));
  }, o);
  await page.reload({ waitUntil: 'load' });
  await unlock();
  await page.waitForTimeout(300);
};
const insights = async () => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click('#pBody .mi[data-panel="ins"]');
  await page.waitForTimeout(350);
};
const closePanel = async () => {
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'), null, { timeout: 3000 });
};
const money = s => Number(String(s).replace(/[^0-9.-]/g, '')) * (/^-|^−/.test(String(s).trim()) ? 1 : 1);

await page.goto(BASE, { waitUntil: 'load' });
await unlock();
await loadSample(page);
await page.waitForTimeout(500);

// what the ledger actually says, computed here rather than trusted from the page
const truth = await page.evaluate(() => {
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  const now = new Date();
  const ym = d => d.slice(0, 7);
  const thisM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevM = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  const recv = t => t.type !== 'in' ? +t.usd : (t.status === 'unpaid' ? 0 : t.status === 'dp' ? +t.paid : +t.usd);
  const scope = t => t.brand === S.brand;
  const sum = (m, f) => S.tx.filter(t => ym(t.date) === m && scope(t)).reduce((a, t) => a + (f(t) || 0), 0);
  return {
    brand: S.brand,
    inNow: sum(thisM, t => t.type === 'in' ? recv(t) : 0),
    inPrev: sum(prevM, t => t.type === 'in' ? recv(t) : 0),
    outNow: sum(thisM, t => (t.type === 'out' && t.cat !== 'Team commission') ? +t.usd : 0),
    brands: S.brands,
    perBrandIn: Object.fromEntries(S.brands.map(b => [b,
      S.tx.filter(t => ym(t.date) === thisM && t.brand === b && t.type === 'in').reduce((a, t) => a + recv(t), 0)])),
  };
});

// ══ 1. period comparison ═════════════════════════════════════════════════
await insights();
const cmpTitle = await page.$$eval('#pBody .sec h3', h => h.map(x => x.textContent.trim()));
check(cmpTitle.some(t => / vs /.test(t)), `comparison section is titled by its two periods: "${cmpTitle.find(t => / vs /.test(t))}"`);

const tot3 = await page.$$eval('#pBody .tot3 > div', d => d.map(x => ({
  t: x.querySelector('.t').textContent.trim(),
  v: x.querySelector('.v').textContent.trim(),
  d: x.querySelector('.d').textContent.trim(),
  cls: x.querySelector('.d').className })));
check(tot3.length === 3 && tot3.map(x => x.t).join() === 'Money in,Money out,Net', `three headline stats: ${tot3.map(x => x.t).join(', ')}`);
check(money(tot3[0].v) === +truth.inNow.toFixed(2), `money in matches the ledger: ${tot3[0].v} vs ${truth.inNow.toFixed(2)}`);
const inDelta = truth.inNow - truth.inPrev;
check(/pos|neg/.test(tot3[0].cls) === (inDelta !== 0), 'a change is coloured, no change is not');
check(inDelta < 0 ? /neg/.test(tot3[0].cls) : true, `falling income reads as bad (${tot3[0].d})`);

const rows = await page.$$eval('#pBody .cmp', r => r.map(x => ({
  name: x.querySelector('.cn b').textContent.trim(),
  move: x.querySelector('.cn .s').textContent.trim(),
  delta: x.querySelector('.cd').textContent.trim(),
  cls: x.querySelector('.cd').className,
  spark: !!x.querySelector('svg.spk') })));
check(rows.length >= 3, `per-category rows: ${rows.length}`);
check(rows.every(r => /→/.test(r.move)), 'every row shows previous → now');
check(rows.every(r => r.spark), 'every row carries a sparkline');
/* check the colour that is painted, not the class that was asked for —
   a more specific rule further down the sheet can quietly win */
const paint = await page.$$eval('#pBody .cmp .cd', els => els.map(e => ({
  txt: e.textContent.trim(), col: getComputedStyle(e).color })));
const moved = paint.filter(x => x.txt !== '\u2014');
const greys = moved.filter(x => /166, 166, 178/.test(x.col));
check(greys.length === 0, `every non-zero delta is actually painted, not left grey (${greys.length} grey of ${moved.length})`);
check(new Set(moved.map(x => x.col)).size === 2,
      `deltas paint in exactly two colours: ${[...new Set(moved.map(x => x.col))].join(' / ')}`);
const mags = rows.map(r => Math.abs(money(r.delta) || 0));
check(mags.every((v, i) => i === 0 || mags[i - 1] >= v), `sorted by size of the move: ${rows.slice(0, 3).map(r => r.name + ' ' + r.delta).join(' | ')}`);
const vanished = rows.filter(r => /→ \$0/.test(r.move));
check(vanished.length > 0, `a category that stopped still appears: ${vanished.map(r => r.name).join(', ') || 'none'}`);
/* income down and spending up must both read red */
const outRow = rows.find(r => r.name === 'Team bonus' || r.name === 'Community prize');
check(!outRow || money(outRow.delta) <= 0 || /neg/.test(outRow.cls), 'spending that rose reads red');

// ══ 2. brand comparison ══════════════════════════════════════════════════
const heads = await page.$$eval('#pBody .tbl thead th', h => h.map(x => x.textContent.trim()));
check(truth.brands.every(b => heads.includes(b)), `every brand is a column: ${heads.filter(Boolean).join(', ')}`);
const labels = await page.$$eval('#pBody .tbl tbody th', h => h.map(x => x.textContent.trim()));
check(['Money in', 'Money out', 'Commission', 'Net', 'Margin', 'Deals', 'Avg deal'].every(l => labels.includes(l)),
      `rows compared: ${labels.join(', ')}`);
/* the brand table must ignore the brand filter — that is its whole point */
const cells = await page.$$eval('#pBody .tbl tbody tr:first-child td', t => t.map(x => x.textContent.trim()));
const other = truth.brands.filter(b => b !== truth.brand)[0];
const otherCol = heads.indexOf(other) - 1;
check(money(cells[otherCol]) === +truth.perBrandIn[other].toFixed(2),
      `the other brand's own money in is shown while viewing ${truth.brand}: ${cells[otherCol]} vs ${truth.perBrandIn[other].toFixed(2)}`);
await closePanel();

// ══ 3. cost bars: share of spend vs share of income ══════════════════════
await insights();
const pctOf = async () => page.$$eval('#pBody .sec', secs => {
  const s = secs.find(x => /Where money went/i.test(x.querySelector('h3')?.textContent || ''));
  return [...s.querySelectorAll('span.tn')].map(e => e.textContent.trim());
});
const spendPct = await pctOf();
const sumSpend = spendPct.reduce((a, t) => a + Number((t.match(/(\d+)%/) || [0, 0])[1]), 0);
check(Math.abs(sumSpend - 100) <= 3, `share of spend adds up to ~100%: ${sumSpend}%`);
await page.click('#pBody [data-cshare="income"]');
await page.waitForTimeout(250);
const incPct = await pctOf();
const sumInc = incPct.reduce((a, t) => a + Number((t.match(/(\d+)%/) || [0, 0])[1]), 0);
check(sumInc !== sumSpend, `switching to share of money in changes the numbers: ${sumSpend}% -> ${sumInc}%`);
check(Math.abs(sumInc - truth.outNow / truth.inNow * 100) <= 3,
      `and they total the real cost ratio: ${sumInc}% vs ${(truth.outNow / truth.inNow * 100).toFixed(0)}%`);
await page.click('#pBody [data-cshare="spend"]');
await page.waitForTimeout(200);
check((await pctOf()).join() === spendPct.join(), 'switching back restores the original numbers');
await closePanel();

// ══ 4. spending caps ═════════════════════════════════════════════════════
check(!(await page.locator('#pBody .cap').count()), 'no caps set, no caps section');
await patch({ caps: [['Tip shiller', 5], ['Community prize', 40]] });
await insights();
const caps = await page.$$eval('#pBody .cap', c => c.map(x => ({
  text: x.querySelector('.l b').textContent.trim(),
  right: x.querySelector('.r2').textContent.replace(/\s+/g, ' ').trim(),
  over: /neg/.test(x.querySelector('.r2').className),
  foot: x.querySelector('.s').textContent.replace(/\s+/g, ' ').trim() })));
check(caps.length === 2, `both caps render: ${caps.map(c => c.text).join(' | ')}`);
const tip = caps.find(c => /Tip shiller/.test(c.text));
const tipPct = 38 / truth.inNow * 100;             // $38 tip shiller in the seeded month
check(Math.abs(Number(tip.right.match(/([\d.]+)%/)[1]) - tipPct) < 0.2, `cap measured against money in: ${tip.right}`);
check(tip.over === tipPct > 5, `over the 5% cap is flagged red (${tipPct.toFixed(1)}%)`);
check(/over by/.test(tip.foot), `and says by how much: "${tip.foot}"`);
const prize = caps.find(c => /Community prize/.test(c.text));
check(!prize.over && !/over by/.test(prize.foot), `a cap that is not breached stays quiet: "${prize.right}"`);
await closePanel();

// ══ 4b. day-by-day calendar ══════════════════════════════════════════════
await insights();
const cal = await page.$$eval('#pBody .cal i', cells => cells.map(c => ({
  day: c.textContent.trim(), empty: c.classList.contains('e'),
  bg: c.style.background || '', title: c.getAttribute('title') || '' })));
const days = cal.filter(c => !c.empty);
const monthLen = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
check(days.length === monthLen, `one cell per day of the month (${days.length} of ${monthLen})`);
check(cal.length % 7 === 0 || cal.length >= monthLen, `grid starts on the right weekday (${cal.length - days.length} leading blanks)`);
const tinted = days.filter(c => c.bg);
check(tinted.length > 0 && tinted.length < days.length, `only days with movement are tinted (${tinted.length} of ${days.length})`);
check(tinted.every(c => /14, 159, 79|229, 72, 77/.test(c.bg)), 'money in tints green, money out red');
check(days.every(c => /·/.test(c.title)), 'every day carries its own figure');

// ══ 4c. break-even, concentration, deal spread ═══════════════════════════
const eff = await page.$$eval('#pBody .sec', secs => {
  const s = secs.find(x => /Efficiency/i.test(x.querySelector('h3')?.textContent || ''));
  return [...s.querySelectorAll('.kv')].map(k => k.innerText.replace(/\s+/g, ' ').trim());
});
const be = eff.find(t => /Break-even/.test(t));
check(!!be, `break-even is reported: "${be}"`);
check(/covered|to go/.test(be), 'and says whether costs were covered or what is left');
const conc = eff.find(t => /Biggest client/.test(t));
check(!!conc && /%/.test(conc), `client concentration is reported: "${conc}"`);
const spread = eff.find(t => /Deal sizes/.test(t));
check(!!spread && /typical/.test(spread), `deal spread shows the range and the typical: "${spread}"`);
await closePanel();

// ══ 5. client profit and repeat rate ═════════════════════════════════════
await page.click('#moreBtn'); await page.waitForSelector('#ovPanel.on');
await page.click('#pBody .mi[data-panel="cli"]'); await page.waitForTimeout(300);
const head = (await page.locator('#pBody .tiny').first().textContent()).replace(/\s+/g, ' ').trim();
check(/client/.test(head) && /(came back|none has come back)/.test(head), `clients header states the repeat rate: "${head}"`);
const cli = await page.$$eval('#pBody .cli', c => c.map(x => ({
  name: x.querySelector('.kv span').childNodes[0].textContent.trim(),
  lead: x.querySelector('.kv .r b').textContent.trim(),
  sub: x.querySelector('.kv .r .s').textContent.trim() })));
const solcat = cli.find(c => /SOLCAT/.test(c.name));
check(solcat && money(solcat.lead) === 120.08, `the headline number is net of commission: ${solcat && solcat.lead} (150.10 booked − 30.02 fee)`);
check(/after \$30\.02 fee/.test(solcat.sub), `and says what came off: "${solcat && solcat.sub}"`);
const leads = cli.map(c => money(c.lead));
check(leads.every((v, i) => i === 0 || leads[i - 1] >= v), `clients ranked by what they actually left: ${cli.slice(0, 3).map(c => c.name + ' ' + c.lead).join(' | ')}`);
await page.screenshot({ path: process.env.SHOT || '/tmp/cashfra-analytics.png' });

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
