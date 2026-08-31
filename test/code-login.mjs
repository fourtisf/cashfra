/* Cashfra code-login test — the access code is the key.
 *
 *   node test/code-login.mjs      (starts its own sync server and web server)
 *
 * Type the code on any device and the book is there; type it wrong and there
 * is no way in. The first check is the one that matters most: the browser and
 * the setup script must derive the SAME key from the same code. If they ever
 * disagree, ALFA is locked out of his own book with both sides looking right.
 */
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join, extname, normalize } from 'path';
import { stubFeed } from './stub-feed.mjs';

const SYNC_PORT = +(process.env.SYNC_PORT || 8981);
const WEB_PORT = +(process.env.WEB_PORT || SYNC_PORT + 1);
const ROOT = new URL('..', import.meta.url).pathname;
const WEB = `http://127.0.0.1:${WEB_PORT}/`;
const SYNC = `${WEB}sync`;
const CODE = '162007';

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};

const DATA = mkdtempSync(join(tmpdir(), 'cashfra-code-'));
/* exactly what deploy/vps-sync-setup.sh runs */
const keyFor = c => execFileSync('node', ['deploy/sync-server.js', '--key', c],
  { env: { ...process.env, DATA_DIR: DATA } }).toString().trim();
const KEY = keyFor(CODE);
writeFileSync(join(DATA, KEY + '.json'), JSON.stringify({ version: 0, at: 0, data: null }));

const server = spawn('node', ['deploy/sync-server.js'],
  { env: { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: DATA }, stdio: 'ignore', detached: true });
/* a second, empty server: somewhere the right code opens nothing, which is
   exactly the state ALFA was in when the card contradicted itself */
const EMPTY = mkdtempSync(join(tmpdir(), 'cashfra-empty-'));
const server2 = spawn('node', ['deploy/sync-server.js'],
  { env: { ...process.env, PORT: String(SYNC_PORT + 5), DATA_DIR: EMPTY }, stdio: 'ignore', detached: true });

/* nginx as ALFA's actually is: an exact match on /sync, nothing beneath it */
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
                '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === '/sync' || url.pathname === '/sync2') {
    const p = httpRequest({ host: '127.0.0.1',
                            port: url.pathname === '/sync2' ? SYNC_PORT + 5 : SYNC_PORT, path: '/',
                            method: req.method, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers); up.pipe(res);
    });
    p.on('error', () => { res.writeHead(502).end(); });
    return req.pipe(p);
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = readFileSync(join(ROOT, rel));
    const h = { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' };
    if (/sw\.js$|\.html$|\.json$/.test(rel)) h['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, h).end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(WEB_PORT, '127.0.0.1');

const cleanup = () => {
  try { process.kill(-server.pid); } catch {}
  try { process.kill(-server2.pid); } catch {}
  try { web.close(); } catch {}
  rmSync(DATA, { recursive: true, force: true });
  rmSync(EMPTY, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); cleanup(); process.exit(1); });
await new Promise(r => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
async function device(name) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await stubFeed(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => bad.push(`${name} pageerror: ` + e.message));
  await page.goto(WEB, { waitUntil: 'load' });
  return { ctx, page, name };
}
const unlock = async (d, code = CODE) => {
  await d.page.waitForSelector('#gate.on', { timeout: 5000 });
  for (const c of code) await d.page.click(`#gPad [data-k="${c}"]`);
};
const opened = d => d.page.waitForFunction(
  () => !document.getElementById('gate').classList.contains('on'), null, { timeout: 5000 });
const ledger = d => d.page.evaluate(() =>
  JSON.parse(localStorage.getItem('fourtis:ledger:v3') || 'null') || { tx: [], sync: {} });

// ══ 1. the two derivations must agree ════════════════════════════════════
const A = await device('A');
const inBrowser = await A.page.evaluate(async ([salt, iter, code]) => {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(code), { name: 'PBKDF2' }, false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: iter, hash: 'SHA-256' }, k, 256);
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}, ['cashfra-sync-v1', 200000, CODE]);
check(inBrowser === KEY,
      `the browser and the server script derive the same key (${KEY.slice(0, 12)}…)`);
check(KEY.length === 64 && /^[0-9a-f]+$/.test(KEY), 'and it is a key, not the code itself');
check(!KEY.includes(CODE), 'the code cannot be read out of it');

check(/same code on any device/i.test(await A.page.textContent('#gNote')),
      'the lock screen stops promising the data never leaves, because now it does');

// ══ 2. the right code brings the book ════════════════════════════════════
/* something for the second device to find */
await unlock(A); await opened(A);
await A.page.waitForTimeout(2500);                    // deriving, then the pull
check(!!(await ledger(A)).sync.token, 'typing the code signs the device in, with nothing else asked');
check((await ledger(A)).sync.token === KEY, 'and the key it uses is the one the server has');

await A.page.click('#addBtn2');
await A.page.waitForSelector('#ovForm.on', { timeout: 3000 });
await A.page.fill('#fAmt', '9');
await A.page.fill('#fParty', '$FIRST_PHONE');
await A.page.locator('#fParty').blur();
await A.page.click('#fSave');
await A.page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await A.page.waitForTimeout(5200);
const onServer = await A.page.evaluate(async ([u, k]) =>
  (await (await fetch(u, { headers: { 'X-Cashfra-Token': k } })).json()).data, [SYNC, KEY]);
check(onServer && onServer.tx.some(t => t.party === '$FIRST_PHONE'), 'what it logs reaches the server');
check(onServer.lockHash === undefined && onServer.lockSalt === undefined,
      'and the code itself is still not among what was sent');

const B = await device('B');
await B.page.waitForSelector('#gate.on', { timeout: 5000 });
check((await ledger(B)).tx.length === 0, 'a second device starts with nothing, as any new phone would');
await unlock(B); await opened(B);
await B.page.waitForFunction(() =>
  JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.some(t => t.party === '$FIRST_PHONE'),
  null, { timeout: 15000 }).catch(() => {});
check((await ledger(B)).tx.some(t => t.party === '$FIRST_PHONE'),
      'the same code on a second device brings the book — nothing else typed, no email');

// ══ 3. a card that says one thing, not two ═══════════════════════════════
/* "Nothing on the server yet" printed over "Wrong access code" says two
   things at once and neither of them helps. */
const D = await device('D');
await D.page.waitForSelector('#gate.on', { timeout: 5000 });
await D.page.waitForFunction(() => !!localStorage.getItem('fourtis:ledger:v3'),
  null, { timeout: 5000 });            // the preset code is seeded before it writes
await D.page.evaluate(k => {           // pointed at a server with no book at all
  const S = JSON.parse(localStorage.getItem('fourtis:ledger:v3'));
  S.sync = { url: k, token: '', ver: 0, at: 0 };
  localStorage.setItem('fourtis:ledger:v3', JSON.stringify(S));
}, WEB + 'sync2');
await D.page.reload({ waitUntil: 'load' });
await unlock(D); await opened(D);
await D.page.waitForFunction(() => document.querySelector('.join') &&
  !/Fetching/.test(document.querySelector('.join h3').textContent), null, { timeout: 15000 }).catch(() => {});
const head = await D.page.textContent('.join h3');
const body = await D.page.textContent('.join p');
check(/does not open the book/i.test(head), `the card names the real problem (${head})`);
check(!/Nothing on the server/i.test(head), 'and does not also claim the server is empty');
check(/different access code/i.test(body), 'the words under it agree with the heading');
await D.ctx.close();

// ══ 4. a wrong code gets nowhere ═════════════════════════════════════════
const C = await device('C');
await C.page.waitForSelector('#gate.on', { timeout: 5000 });
await unlock(C, '999999');
await C.page.waitForTimeout(1500);
check(await C.page.locator('#gate').evaluate(e => e.classList.contains('on')),
      'a wrong code does not open the app');
check(/Wrong code/.test(await C.page.textContent('#gErr')), 'and says so');
check((await ledger(C)).tx.length === 0, 'and brings nothing down');
const guessed = await C.page.evaluate(async u => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': 'a'.repeat(64) } });
  return r.status;
}, SYNC);
check(guessed === 401, `a key that was never made is refused by the server too (${guessed})`);

// ══ 5. changing the code takes the book with it ══════════════════════════
await A.page.click('#moreBtn');
await A.page.waitForSelector('#ovPanel.on', { timeout: 3000 });
await A.page.click('#pBody .mi[data-panel="set"]');
await A.page.waitForSelector('#pBody [data-lock="change"]', { timeout: 3000 });
await A.page.click('#pBody [data-lock="change"]');
await A.page.waitForSelector('#g1', { timeout: 3000 });
await A.page.fill('#g1', '445566');
await A.page.fill('#g2', '445566');
await A.page.click('#gGo');
await A.page.waitForTimeout(4000);
const NEWKEY = keyFor('445566');
check((await ledger(A)).sync.token === NEWKEY, 'changing the code changes the key');
const moved = await A.page.evaluate(async ([u, k]) => {
  const r = await fetch(u, { headers: { 'X-Cashfra-Token': k } });
  return r.status === 200 ? (await r.json()).data : null;
}, [SYNC, NEWKEY]);
check(moved && moved.tx.some(t => t.party === '$FIRST_PHONE'),
      'and the book moved with it, rather than being left under the old one');
const stale = await A.page.evaluate(async ([u, k]) =>
  (await fetch(u, { headers: { 'X-Cashfra-Token': k } })).status, [SYNC, KEY]);
check(stale === 401, `the old code no longer opens anything (${stale})`);
check(readdirSync(DATA).filter(f => f.endsWith('.json')).length === 1,
      'one book on the server, not two — the old one was moved, not copied');

// ══ 6. guessing is not free ══════════════════════════════════════════════
/* Last, deliberately: every device here shares one address, so the block this
   earns would fall on the others too. On a real server nginx passes the
   caller's own address and they are counted apart. */
const codes = await C.page.evaluate(async u => {
  const out = [];
  for (let i = 0; i < 25; i++) {
    const r = await fetch(u, { headers: { 'X-Cashfra-Token': String(i).padStart(64, 'b') } });
    out.push(r.status);
  }
  return out;
}, SYNC);
check(codes.includes(429), `guessing gets cut off, it does not run for ever (${codes.filter(c => c === 429).length} of 25 blocked)`);


await browser.close();
cleanup();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
