/* Cashfra sign-in test — email plus a six-digit code.
 *
 *   node test/login.mjs        (starts its own sync server and web server)
 *
 * The point of signing in is that a device nobody has touched shows the same
 * book. So the last checks here open a second browser context with an empty
 * ledger, sign it in, and look for the first device's entries.
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { createServer as httpServer, request as httpRequest } from 'http';
import { createServer as tlsServer } from 'tls';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, extname, normalize } from 'path';
import { stubFeed } from './stub-feed.mjs';

const SYNC_PORT = +(process.env.SYNC_PORT || 8871);
const WEB_PORT = +(process.env.WEB_PORT || SYNC_PORT + 1);
const SMTP_PORT = +(process.env.SMTP_PORT || SYNC_PORT + 2);
const ROOT = new URL('..', import.meta.url).pathname;
const WEB = `http://127.0.0.1:${WEB_PORT}/`;
const SYNC = `${WEB}sync`;
const MINE = 'alfa@example.com';
const THEIRS = 'someone@else.com';

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const report = () => {
  console.log(ok.map(s => '  PASS  ' + s).join('\n'));
  if (bad.length) console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n'));
};

const DATA = mkdtempSync(join(tmpdir(), 'cashfra-login-'));
const MAILDIR = join(DATA, 'outbox');

/* ── a fake SMTP server, so the client is tested rather than trusted ───────
   Nothing here can reach Gmail, and an SMTP client that has never completed a
   conversation is not a client, it is a hope. This one speaks the sequence
   Gmail does on 465 — implicit TLS included, with a throwaway certificate,
   because plaintext SMTP is not the path that ships. */
const smtpSeen = [];
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-keyout', join(DATA, 'k.pem'), '-out', join(DATA, 'c.pem')],
  { stdio: 'ignore' });
const smtp = tlsServer({ key: readFileSync(join(DATA, 'k.pem')), cert: readFileSync(join(DATA, 'c.pem')) },
  sock => {
    let buf = '', inData = false, msg = '', auth = 0;
    sock.write('220 fake ESMTP\r\n');
    sock.on('error', () => {});
    sock.on('data', c => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; smtpSeen.push(msg); msg = ''; sock.write('250 queued\r\n'); }
          else msg += line.replace(/^\.\./, '.') + '\n';
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (up === 'AUTH LOGIN') { auth = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (auth === 1) { auth = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (auth === 2) { auth = 3; sock.write('235 authenticated\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (up.startsWith('MAIL FROM') || up.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
smtp.listen(SMTP_PORT, '127.0.0.1');

const server = spawn('node', ['deploy/sync-server.js'], {
  env: { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: DATA,
         ALLOW: MINE, MAIL_MODE: 'file', MAIL_DIR: MAILDIR },
  stdio: 'ignore', detached: true
});

const web = httpServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) {
    const p = httpRequest({ host: '127.0.0.1', port: SYNC_PORT, path: url.pathname,
                            method: req.method, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers); up.pipe(res);
    });
    p.on('error', () => { res.writeHead(502).end(); });
    return req.pipe(p);
  }
  const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
                  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
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
  try { web.close(); } catch {}
  try { smtp.close(); } catch {}
  rmSync(DATA, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('uncaughtException', e => { report(); console.log('\n  CRASH  ' + e.message.split('\n')[0]); cleanup(); process.exit(1); });
await new Promise(r => setTimeout(r, 900));

const inbox = () => { try { return readdirSync(MAILDIR); } catch (e) { return []; } };
const codeFor = () => {                      // read the "inbox"
  const f = inbox();
  if (!f.length) return null;
  const txt = readFileSync(join(MAILDIR, f[f.length - 1]), 'utf8');
  const m = txt.match(/\b(\d{6})\b/);
  return m && m[1];
};
const api = (path, body) => fetch(`${WEB}sync${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(async r => ({ code: r.status, body: await r.json().catch(() => ({})) }));

// ══ the server's own rules ═══════════════════════════════════════════════
let r = await api('/auth/start', { email: THEIRS });
check(r.code === 403, `an address that was not allow-listed is turned away (${r.code})`);
check(inbox().length === 0, 'and no mail is sent to it');

r = await api('/auth/start', { email: 'not-an-email' });
check(r.code === 400, 'nonsense is rejected before anything is sent');

r = await api('/auth/start', { email: MINE.toUpperCase() });
check(r.code === 200, 'the allow-list does not care about capitals');
const code = codeFor();
check(/^\d{6}$/.test(code || ''), `a six-digit code goes out (${code})`);

r = await api('/auth/verify', { email: MINE, code: '000000' === code ? '111111' : '000000' });
check(r.code === 401, 'a wrong code is refused');
check(/\d left/.test(r.body.error || ''), `and says how many tries remain (${r.body.error})`);

r = await api('/auth/verify', { email: MINE, code });
check(r.code === 200 && /^[A-Za-z0-9_-]{16,128}$/.test(r.body.token || ''),
      'the right code hands back a token');
const token = r.body.token;

r = await api('/auth/verify', { email: MINE, code });
check(r.code === 401, 'the same code cannot be used twice');

/* signing in again must land on the same book, or the whole idea fails */
await api('/auth/start', { email: MINE });
r = await api('/auth/verify', { email: MINE, code: codeFor() });
check(r.body.token === token, 'signing in again returns the same account, not a new one');

const guess = await fetch(SYNC, { headers: { 'X-Cashfra-Token': 'never_issued_aaaaaa' } });
check(guess.status === 401, `a token that was never issued is still refused (${guess.status})`);

// ══ losing a device ══════════════════════════════════════════════════════
/* Every signed-in device holds the same token, so a lost phone means moving
   the account to a new one. The book has to move with it — an account whose
   ledger stayed behind under the old token is a lost ledger. */
await fetch(SYNC, {                                   // put something in the book first
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Cashfra-Token': token },
  body: JSON.stringify({ base: 0, data: { tx: [{ id: 'r1', date: '2026-08-01', party: '$BEFORE' }] } })
});
execFileSync('node', ['deploy/sync-server.js', '--rotate', MINE],
  { env: { ...process.env, DATA_DIR: DATA }, stdio: 'ignore' });
const old = await fetch(SYNC, { headers: { 'X-Cashfra-Token': token } });
check(old.status === 401, `the lost device's token stops working (${old.status})`);
await api('/auth/start', { email: MINE });
r = await api('/auth/verify', { email: MINE, code: codeFor() });
check(r.code === 200 && r.body.token !== token, 'signing in again hands out a different one');
const moved = await fetch(SYNC, { headers: { 'X-Cashfra-Token': r.body.token } }).then(x => x.json());
check(moved.data && moved.data.tx && moved.data.tx[0] && moved.data.tx[0].party === '$BEFORE',
      'and the book moved with it — rotating locks a device out, it does not erase');

// ══ the SMTP client, against a server that answers ═══════════════════════
const smtpSrv = spawn('node', ['deploy/sync-server.js'], {
  env: { ...process.env, PORT: String(SYNC_PORT + 10), DATA_DIR: DATA, ALLOW: MINE,
         MAIL_MODE: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT),
         SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'cashfra@example.com',
         SMTP_INSECURE: '1' },
  stdio: 'ignore', detached: true
});
await new Promise(r2 => setTimeout(r2, 700));
const sr = await fetch(`http://127.0.0.1:${SYNC_PORT + 10}/auth/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: MINE })
}).then(x => x.status).catch(() => 0);
try { process.kill(-smtpSrv.pid); } catch {}
check(sr === 200, `the SMTP path completes a real conversation (${sr})`);
check(smtpSeen.length === 1 && /Subject: Cashfra sign-in code: \d{6}/.test(smtpSeen[0] || ''),
      'and the message that arrives carries the code in its subject');

// ══ the app: a new device signs in and the book is there ═════════════════
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
const settings = async d => {
  await d.page.click('#moreBtn');
  await d.page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await d.page.click('#pBody .mi[data-panel="set"]');
  await d.page.waitForSelector('#pSyncUrl', { timeout: 3000 });
};
const signIn = async d => {
  await settings(d);
  check(await d.page.locator('#pSyncUrl').inputValue() === SYNC,
        `${d.name} already knows the address it was served from`);
  await d.page.fill('#pAuthMail', MINE);
  await d.page.click('[data-auth="start"]');
  await d.page.waitForSelector('#pAuthCode', { timeout: 8000 });
  await d.page.fill('#pAuthCode', codeFor());
  await d.page.click('[data-auth="verify"]');
  await d.page.waitForTimeout(2500);
};
const ledger = d => d.page.evaluate(() => JSON.parse(localStorage.getItem('fourtis:ledger:v3')));

const A = await device('A');
check(!(await ledger(A)).sync.token, 'a fresh install is not signed in to anything');
await settings(A);
check((await A.page.locator('#pSyncTok').count()) === 0,
      'and shows no token box to copy anything into');

await A.page.fill('#pAuthMail', THEIRS);
await A.page.click('[data-auth="start"]');
await A.page.waitForTimeout(1200);
check(!(await A.page.locator('#pAuthCode').count()),
      'an address the server will not accept never reaches the code step');
check(/does not accept/.test(await A.page.textContent('#pBody')),
      'and the reason is on screen, not swallowed');

await A.page.fill('#pAuthMail', MINE);
await A.page.click('[data-auth="start"]');
await A.page.waitForSelector('#pAuthCode', { timeout: 8000 });
await A.page.fill('#pAuthCode', '000123');
await A.page.click('[data-auth="verify"]');
await A.page.waitForTimeout(1200);
check(/not right|new code/.test(await A.page.textContent('#pBody')), 'a wrong code says so and stays put');
await A.page.fill('#pAuthCode', codeFor());
await A.page.click('[data-auth="verify"]');
await A.page.waitForTimeout(2500);
const afterA = await ledger(A);
check(!!afterA.sync.token, 'the right one signs in');
check(afterA.sync.email === MINE, 'and the app remembers whose account it is');
check(/Signed in/.test(await A.page.textContent('#pBody')), 'the panel now says so instead of asking again');
await A.page.click('#pClose');
await A.page.waitForTimeout(300);

/* something worth finding on the other device */
await A.page.click('#addBtn2');
await A.page.waitForSelector('#ovForm.on', { timeout: 3000 });
await A.page.fill('#fAmt', '4');
await A.page.fill('#fParty', '$FROM_PHONE');
await A.page.locator('#fParty').blur();
await A.page.click('#fSave');
await A.page.waitForFunction(() => !document.getElementById('ovForm').classList.contains('on'), null, { timeout: 3000 });
await A.page.waitForTimeout(5200);

const B = await device('B');
check((await ledger(B)).tx.length === 0, 'the second device starts empty, as any new phone would');
await signIn(B);
const afterB = await ledger(B);
check(afterB.tx.some(t => t.party === '$FROM_PHONE'),
      'signing in is all it takes — the history is there, with nothing copied by hand');
check(afterB.tx.length === afterA.tx.length + 1,
      `and it is the whole book (${afterB.tx.length} entries)`);
check(!afterB.lockHash || afterB.lockHash === (await ledger(A)).lockHash,
      'the access code is each device’s own — it is not what was fetched');

await browser.close();
cleanup();
report();
if (bad.length) process.exit(1);
console.log(`\n${ok.length} checks passed`);
