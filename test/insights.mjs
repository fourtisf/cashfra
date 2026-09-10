/* Cashfra insights test — the three things ALFA could not read off this panel.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/insights.mjs
 *
 * All three were the same fault in different places: the screen held the
 * answer and never said it out loud. The cost toggle changed a small grey
 * percentage and nothing else, so both sides read as the same screen twice.
 * The calendar put each day's figure in a `title`, which is a hover, and a
 * phone has none. And the period lived on the hero, behind the sheet covering
 * it, so the month could only be changed by closing the analysis.
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

const money = s => Number(String(s).replace(/[^0-9.-]/g, ''));
const openIns = async () => {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click('#pBody .mi[data-panel="ins"]');
  await page.waitForTimeout(400);
};
/* every "Where money went" row, as [label, amount, percent] */
const spendRows = () => page.evaluate(() => [...document.querySelectorAll('#pBody .ibar.o')]
  .map(bar => {
    const t = (bar.previousElementSibling || {}).textContent || '';
    const m = /(-?\$[\d,.]+)\s*(\d+)%/.exec(t.replace(/\s+/g, ' '));
    return m ? [t.replace(/\s+/g, ' ').trim(), Number(m[1].replace(/[^0-9.-]/g, '')), +m[2]] : null;
  }).filter(Boolean));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#gate.on');
for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'));
await loadSample(page);
await page.waitForTimeout(500);
await openIns();

// ══ 1. the two cost shares are two different questions ═══════════════════
const spend = await spendRows();
check(spend.length > 1, `the spending breakdown renders (${spend.length} categories)`);
const baseSpend = (await page.locator('#pBody').innerText()).match(/Each share out of (\$[\d,.]+) that went out/);
check(!!baseSpend, `it names what it is dividing by: "${baseSpend ? baseSpend[0] : '(missing)'}"`);
/* the shares are of the spending, so they add up to it */
const sumSpend = spend.reduce((s, r) => s + r[1], 0);
check(Math.abs(sumSpend - money(baseSpend[1])) < 1,
      `and that figure is the spending itself: ${baseSpend[1]} for ${sumSpend.toFixed(2)} of rows`);

await page.click('#pBody [data-cshare="income"]'); await page.waitForTimeout(350);
const inShare = await spendRows();
const baseIn = (await page.locator('#pBody').innerText()).match(/Each share out of (\$[\d,.]+) that came in/);
check(!!baseIn, `switching says so too: "${baseIn ? baseIn[0] : '(missing)'}"`);
check(money(baseIn[1]) !== money(baseSpend[1]),
      `and it is a different number, which is the whole point: ${baseSpend[1]} vs ${baseIn[1]}`);
check(inShare.length === spend.length && inShare.every((r, i) => r[1] === spend[i][1]),
      'the amounts do not move — only what they are a share of');
check(inShare.some((r, i) => r[2] !== spend[i][2]),
      `and the percentages do: ${spend[0][2]}% of spend is ${inShare[0][2]}% of money in`);
/* the reading that was being missed: money in is the larger base, so every
   share of it is the smaller number */
check(inShare.every((r, i) => r[2] <= spend[i][2]),
      'a share of money in is never the larger of the two');

// ══ 2. a day on the calendar says what it was, without a hover ═══════════
const cal = page.locator('#pBody .cal button');
const n = await cal.count();
check(n > 0, `days with money on them are buttons, not dead cells (${n} of them)`);
check((await page.locator('#pBody .cal i[title]').count()) === 0,
      'and no figure is left in a title, which a phone can never show');
const label = await cal.first().getAttribute('aria-label');
check(/\$/.test(label || ''), `each one carries its figure for a screen reader too: "${label}"`);
await cal.first().click(); await page.waitForTimeout(300);
const picked = await page.locator('#pBody').innerText();
const dayLine = picked.match(/(\d+ \w+ \d+)\n(\d+ entr[^\n]*)\n(-?\$[\d,.]+)/);
check(!!dayLine, `tapping one spells the day out: "${dayLine ? dayLine.slice(1).join(' · ') : '(missing)'}"`);
check(money(dayLine[3]) === money(/(-?\$[\d,.]+)/.exec(label)[1]),
      `and it agrees with the day tapped: ${dayLine[3]}`);
check((await page.locator('#pBody .cal button.sel').count()) === 1, 'the day tapped is the one marked');
await cal.first().click(); await page.waitForTimeout(300);
check((await page.locator('#pBody .cal button.sel').count()) === 0,
      'tapping it again puts it away rather than leaving it stuck open');

// ══ 3. the period can be moved without closing the analysis ══════════════
const bar = page.locator('#pBody .pbar');
check(await bar.count() === 1, 'the panel carries the period it is showing');
const was = (await bar.locator('b').textContent()).trim();
await page.click('#pBody [data-pstep="-1"]'); await page.waitForTimeout(400);
const now = (await page.locator('#pBody .pbar b').textContent()).trim();
check(now !== was, `‹ steps it back without leaving the panel: ${was} → ${now}`);
check(await page.locator('#ovPanel').evaluate(e => e.classList.contains('on')), 'and the panel is still open');
check((await page.locator('#mLbl').textContent()).trim() === now,
      `the hero behind it moved with it, not against it: ${now}`);
await page.click('#pBody [data-pstep="1"]'); await page.waitForTimeout(400);
check((await page.locator('#pBody .pbar b').textContent()).trim() === was, `and › comes back: ${was}`);

await page.click('#pBody .pbar [data-sper="w"]'); await page.waitForTimeout(400);
check(await page.locator('#pBody .pbar [data-sper="w"]').evaluate(e => e.classList.contains('on')),
      'Week takes over from Month in the panel');
check(await page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')).per) === 'w',
      'and it is the app’s one period that changed, not a second one owned by this screen');
check((await page.locator('#pBody .cal').count()) === 0,
      'the month grid steps aside in week view rather than showing a month that is not on screen');
await page.click('#pBody .pbar [data-sper="m"]'); await page.waitForTimeout(400);

await browser.close();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
