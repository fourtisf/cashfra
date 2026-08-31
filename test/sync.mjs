/* Cashfra sync test — one ledger, several devices.
 *
 *   node test/sync.mjs        (starts its own sync server and web server)
 *
 * Two browser contexts stand in for two devices. What matters is that a device
 * that was behind never erases what the other one wrote.
 */
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join, extname, normalize } from 'path';
import { stubFeed } from './stub-feed.mjs';
import { loadSample } from './helpers.mjs';

const SYNC_PORT = +(process.env.SYNC_PORT || 8789);
const WEB_PORT = +(process.env.WEB_PORT || SYNC_PORT + 1);
const ROOT = new URL('..', import.meta.url).pathname;
/* The access code is the key now: the server's file is named by what the app
   derives from 162007, and a device joins by typing it. Nothing is copied. */
const CODE = '162007';
const TOKEN = execFileSync('node', ['-e',
  'const k=require("crypto");process.stdout.write(k.pbkdf2Sync(process.argv[1],"cashfra-sync-v1",200000,32,"sha256").toString("hex"))',
  CODE]).toString();
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
/* nothing to configure any more — unlocking is the whole of it */
const configure = async d => {
  await d.page.waitForFunction(() => {
    const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3') || 'null');
    return S && S.sync && S.sync.token;
  }, null, { timeout: 15000 });
  await d.page.waitForTimeout(1200);         // the derive, then the pull
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
await configure(A);            /* the derive is not instant; wait, then look */
check((await ledger(A)).sync.token === TOKEN,
      'typing the access code is the whole of joining — the key comes from it');
await loadSample(A.page);
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
const syncStatus = async (d, times = 2) => {
  await d.page.click('#moreBtn');
  await d.page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await d.page.click('#pBody .mi[data-panel="set"]');
  await d.page.waitForSelector('#pBody [data-sync="now"]', { timeout: 3000 });
  const line = d.page.locator('#syncNote');
  const out = [];
  for (let i = 0; i < times; i++) {
    await d.page.click('#pBody [data-sync="now"]');
    await d.page.waitForFunction(
      () => !/Syncing|Fetching/.test(document.querySelector('#syncNote').textContent),
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

// ── a device that loses the race does not stay behind ─────────────────────
/* Force the one window that matters: another device writes between this
   device's read and its write. The device has to recover inside that single
   exchange — one that gives up here sits on its entry until it is next
   edited, silently out of step, which is the failure sync exists to prevent.
   So the whole exchange is recorded and read back: one refusal, one retry,
   and the entry landing. A later background sync cannot be what rescues it. */
await A.page.evaluate(([u, t]) => {
  const real = window.fetch;
  window.__armed = 0; window.__log = [];
  window.fetch = function (url, opt) {
    const tok = opt && opt.headers && opt.headers['X-Cashfra-Token'];
    const isGet = !opt || !opt.method || opt.method === 'GET';
    return real.apply(this, arguments).then(async res => {
      if (tok) window.__log.push((opt.method || 'GET') + ' -> ' + res.status +
        (opt.body ? ' tx=' + JSON.parse(opt.body).data.tx.length : ''));
      if (tok && isGet && window.__armed) {
        window.__armed = 0;                       // exactly one interception
        const cur = await (await real(u, { headers: { 'X-Cashfra-Token': t } })).json();
        await real(u, { method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Cashfra-Token': t },
          body: JSON.stringify({ base: cur.version,
            data: Object.assign({}, cur.data, { invNote: 'written by the other device' }) }) });
      }
      return res;
    });
  };
}, [SYNC, TOKEN]);

await addEntry(A, '$RACED', 5);
await A.page.waitForFunction(() =>
  JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.some(t => t.party === '$RACED'),
  null, { timeout: 5000 });
const held = (await ledger(A)).tx.length;
await A.page.evaluate(() => { window.__armed = 1; window.__log = []; });
const racedMsg = (await syncStatus(A, 1))[0];
const log = await A.page.evaluate(() => window.__log);
check(log.length === 4 && /PUT -> 409/.test(log[1]) && /PUT -> 200/.test(log[3]),
      `refused once, then carried through on the same exchange (${log.join(' | ')})`);
check(/^Synced/.test(racedMsg), `and it reads as synced, not as an error (${racedMsg})`);
const after = await A.page.evaluate(async ([u, t]) => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': t } });
  return (await r.json()).data;
}, [SYNC, TOKEN]);
check(after.tx.some(t => t.party === '$RACED') && after.tx.length === held,
      `the entry it was holding reaches the server (${after.tx.length} of ${held})`);
check(after.invNote === 'written by the other device',
      'and the other device\u2019s write is not overwritten by the retry');

// ── removing the code stops sync, because the code is the key ─────────────
/* The trade in making the code the login: no code, no key, no book. That has
   to be visible rather than silent — a device quietly not syncing is the
   failure this whole feature exists to remove. */
await B.page.click('#moreBtn');
await B.page.waitForSelector('#ovPanel.on', { timeout: 3000 });
await B.page.click('#pBody .mi[data-panel="set"]');
await B.page.waitForSelector('#pBody [data-lock="remove"]', { timeout: 3000 });
await B.page.click('#pBody [data-lock="remove"]');
await B.page.click('#tAct');                                   // confirm
await B.page.waitForTimeout(800);
check(!(await ledger(B)).lockHash, 'the access code can still be removed');
/* it does NOT stop syncing: the key was derived once and is held here. That
   is the better behaviour, so what has to be right is what the panel says —
   a new device still joins by typing the code, and there is now nowhere on
   this one to read it from. */
const said = await B.page.textContent('#pBody');
check(/keeps syncing/i.test(said), 'and this device carries on — it already holds the key');
check(/typing the access code/i.test(said) && /written down/i.test(said),
      'while warning that a new device still needs the code, which is now nowhere on this one');
await B.page.click('#pClose');
await B.page.waitForTimeout(300);

await addEntry(A, '$AFTER_REMOVAL', 6);
await A.page.waitForTimeout(5200);
await B.page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await B.page.waitForTimeout(300);
await B.page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await B.page.waitForTimeout(2000);
const stillOn = await ledger(B);
check(stillOn.tx.some(t => t.party === '$AFTER_REMOVAL'),
      'and it is really still connected, not merely claiming to be');

// ── the access code never leaves the device ───────────────────────────────
const onServer = await A.page.evaluate(async ([u, t]) => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': t } });
  return (await r.json()).data;
}, [SYNC, TOKEN]);
check(onServer && onServer.lockHash === undefined && onServer.lockSalt === undefined,
      'the access code is never sent to the server');
check(onServer.sync === undefined, 'and neither is the token');
const local = await ledger(A);          // the race and the removal check added more
check(Array.isArray(onServer.tx) && onServer.tx.length === local.tx.length,
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
