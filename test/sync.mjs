/* Cashfra sync test — one ledger, several devices.
 *
 *   node test/sync.mjs        (starts its own sync server and web server)
 *
 * Two browser contexts stand in for two devices. What matters is that a device
 * that was behind never erases what the other one wrote.
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join, extname, normalize } from 'path';
import { stubFeed } from './stub-feed.mjs';
import { loadSample } from './helpers.mjs';

const SYNC_PORT = +(process.env.SYNC_PORT || 8789);
const WEB_PORT = +(process.env.WEB_PORT || SYNC_PORT + 1);
const ROOT = new URL('..', import.meta.url).pathname;
const TOKEN = 'cashfra_test_token_0001';
/* The app and the sync endpoint share one origin here because they share one
   in production — nginx puts /sync on cashfra.com. On two origins the service
   worker would never see the sync at all and this suite would not be testing
   the thing it ships. */
const WEB = `http://127.0.0.1:${WEB_PORT}/`;
const SYNC = `${WEB}sync`;

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};

const DATA = mkdtempSync(join(tmpdir(), 'cashfra-sync-'));
writeFileSync(join(DATA, TOKEN + '.json'), JSON.stringify({ version: 0, at: 0, data: null }));
const server = spawn('node', ['deploy/sync-server.js'],
  { env: { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: DATA }, stdio: 'ignore', detached: true });

/* nginx, in thirty lines: static files, and /sync proxied to the service */
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
                '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
                '.webmanifest': 'application/manifest+json' };
const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === '/sync') {
    const p = httpRequest({ host: '127.0.0.1', port: SYNC_PORT, path: '/',
                            method: req.method, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    p.on('error', () => { res.writeHead(502).end(); });
    return req.pipe(p);
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = readFileSync(join(ROOT, rel));
    const h = { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' };
    /* the same header the live site sets, and for the same reason */
    if (/sw\.js$|\.html$|\.json$/.test(rel)) h['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, h).end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(WEB_PORT, '127.0.0.1');

const cleanup = () => {
  try { process.kill(-server.pid); } catch {}
  try { web.close(); } catch {}
  rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); process.exit(1); });
await new Promise(r => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function device(name) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await stubFeed(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => bad.push(`${name} pageerror: ` + e.message));
  await page.goto(WEB, { waitUntil: 'load' });
  await page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const d of '162007') await page.click(`#gPad [data-k="${d}"]`);
  await page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
  return { ctx, page, name };
}
const controlled = d => d.page.evaluate(() =>
  navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller).catch(() => false));
const ledger = d => d.page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
const configure = async d => {
  await d.page.evaluate(([u, t]) => {
    const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
    S.sync = { url: u, token: t, ver: 0, at: 0 };
    localStorage.setItem('fourtis:ledger:v3', JSON.stringify(S));
  }, [SYNC, TOKEN]);
  await d.page.reload({ waitUntil: 'load' });
  await d.page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const c of '162007') await d.page.click(`#gPad [data-k="${c}"]`);
  await d.page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
  await d.page.waitForTimeout(900);          // startApp pulls
};
const addEntry = async (d, party, amt) => {
  await d.page.click('#addBtn2');
  await d.page.waitForSelector('#ovForm.on', { timeout: 3000 });
  await d.page.fill('#fAmt', String(amt));
  await d.page.fill('#fParty', party);
  await d.page.locator('#fParty').blur();
  await d.page.click('#fSave');
  await d.page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
  await d.page.waitForTimeout(600);
};

// ── off by default ────────────────────────────────────────────────────────
const A = await device('A');
check(!(await ledger(A)).sync.url, 'sync is off until a server is entered');

await loadSample(A.page);
await configure(A);
await addEntry(A, '$ALPHA', 2);
await A.page.waitForTimeout(5000);          // the push is debounced
const afterA = await ledger(A);
check(afterA.sync.ver > 0, `device A pushed on its own (version ${afterA.sync.ver})`);

// ── a second device picks the ledger up ───────────────────────────────────
const B = await device('B');
check((await ledger(B)).tx.length === 0, 'device B starts with its own empty book');
await configure(B);
const afterB = await ledger(B);
check(afterB.tx.length === afterA.tx.length, `B pulled the whole ledger (${afterB.tx.length} entries)`);
check(afterB.tx.some(t => t.party === '$ALPHA'), 'including the entry A had just made');

// ── neither device can erase the other ────────────────────────────────────
await addEntry(A, '$ONLY_A', 3);
await addEntry(B, '$ONLY_B', 4);
await A.page.waitForTimeout(5200);
await B.page.waitForTimeout(5200);
await A.page.evaluate(() => location.reload());
await A.page.waitForSelector('#gate.on', { timeout: 5000 });
for (const c of '162007') await A.page.click(`#gPad [data-k="${c}"]`);
await A.page.waitForFunction(() => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
await A.page.waitForTimeout(1500);
const merged = await ledger(A);
const names = merged.tx.map(t => t.party);
check(names.includes('$ONLY_A') && names.includes('$ONLY_B'),
      `both devices' work survives the merge (${names.filter(n => /ONLY/.test(n)).join(', ')})`);
check(new Set(merged.tx.map(t => t.id)).size === merged.tx.length, 'no entry is duplicated by the merge');

// ── syncing twice in a row is not a conflict ──────────────────────────────
/* the second exchange must see the version the first one wrote. A service
   worker serving the first GET from its cache would hide it, and every write
   after that would be refused as stale. */
const syncStatus = async d => {
  await d.page.click('#moreBtn');
  await d.page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await d.page.click('#pBody .mi[data-panel="set"]');
  await d.page.waitForSelector('#pBody [data-sync="now"]', { timeout: 3000 });
  const line = d.page.locator('#pBody .sec').filter({ hasText: 'Sync across devices' })
                     .locator('p.tiny').last();
  const out = [];
  for (let i = 0; i < 2; i++) {
    await d.page.click('#pBody [data-sync="now"]');
    await d.page.waitForFunction(
      () => !/Syncing/.test(document.querySelector('#pBody [data-sync="now"]')
              .closest('.sec').querySelector('p.tiny:last-child').textContent),
      null, { timeout: 8000 }).catch(() => {});
    await d.page.waitForTimeout(400);
    out.push((await line.textContent()).trim());
  }
  await d.page.click('#pClose');
  await d.page.waitForTimeout(300);
  return out;
};
check(await controlled(A), 'the service worker is running, as it is on the live site');
const twice = await syncStatus(A);
check(twice.every(t => /^Synced/.test(t)), `two syncs back to back both land (${twice.join(' | ')})`);

// ── the access code never leaves the device ───────────────────────────────
const onServer = await A.page.evaluate(async ([u, t]) => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': t } });
  return (await r.json()).data;
}, [SYNC, TOKEN]);
check(onServer && onServer.lockHash === undefined && onServer.lockSalt === undefined,
      'the access code is never sent to the server');
check(onServer.sync === undefined, 'and neither is the token');
check(Array.isArray(onServer.tx) && onServer.tx.length === merged.tx.length,
      `the server holds the merged ledger (${onServer.tx.length} entries)`);

// ── a bad token is refused ────────────────────────────────────────────────
const refused = await A.page.evaluate(async u => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': 'wrong_token_aaaaaaaa' } });
  return r.status;
}, SYNC);
check(refused === 401, `an unknown token is refused (${refused})`);

await browser.close();
cleanup();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
