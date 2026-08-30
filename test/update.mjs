/* Cashfra deploy test — proves a redeploy actually reaches an installed copy.
 *
 * Runs against a throwaway copy of the site, bumps the build mid-test, and
 * checks the handover: install in the background, never reload a live screen,
 * swap on backgrounding, purge the old cache, serve the new shell offline.
 *
 *   node test/update.mjs        (starts its own server on SITE_PORT, default 8125)
 */
import { chromium, devices } from 'playwright';
import { execSync, spawn } from 'child_process';
import { cpSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = process.env.SITE_PORT || 8125;
const BASE = `http://127.0.0.1:${PORT}/`;

/* a throwaway copy of the site, served with the production headers */
const SITE = mkdtempSync(join(tmpdir(), 'cashfra-deploy-'));
for (const f of ['index.html', 'manifest.json', 'sw.js', 'favicon.ico', 'robots.txt',
                 'icons', 'bump-version.sh'])
  cpSync(f, join(SITE, f), { recursive: true });
const server = spawn('python3', ['dev-server.py', String(PORT), SITE],
                     { stdio: 'ignore', detached: true });
const cleanup = () => { try { process.kill(-server.pid); } catch {} rmSync(SITE, { recursive: true, force: true }); };
process.on('exit', cleanup);
await new Promise(r => setTimeout(r, 1200));
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await b.newContext({ ...devices['Pixel 7'] });
const p = await ctx.newPage();

const state = () => p.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { installing: r?.installing?.state, waiting: r?.waiting?.state,
           active: r?.active?.state, caches: (await caches.keys()).sort() };
});
/* poll until `pred(state)` or give up after ms */
const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  let s;
  do { s = await state(); if (pred(s)) return s; await p.waitForTimeout(300); } while (Date.now() < end);
  return s;
};

await p.goto(BASE, { waitUntil: 'load' });
await p.evaluate(() => navigator.serviceWorker.ready);
const s0 = await until(s => s.active === 'activated');
const v1 = s0.caches[0];
check(s0.active === 'activated' && /^cashfra-/.test(v1), `installed as ${v1}`);

// ── ship a new build ──────────────────────────────────────────────────────
execSync('./bump-version.sh', { cwd: SITE });
execSync(`sed -i 's|<title>Cashfra</title>|<title>Cashfra v2</title>|' ${SITE}/index.html`);

await p.goto(BASE, { waitUntil: 'load' });
const s1 = await until(s => s.waiting === 'installed');
check(s1.waiting === 'installed', `new build installs and waits (waiting=${s1.waiting})`);
check(s1.caches.length === 2, `both shells held while it waits: ${s1.caches}`);
check((await p.title()) === 'Cashfra', 'the live page is never reloaded out from under the user');

// ── the swap happens once the app is backgrounded ─────────────────────────
await p.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const s2 = await until(s => !s.waiting && s.caches.length === 1);
check(!s2.waiting && s2.caches.length === 1 && s2.caches[0] !== v1,
      `backgrounding swaps in the new build and purges the old cache: ${v1} -> ${s2.caches}`);

// ── the next launch is the new build, with no network ─────────────────────
await ctx.setOffline(true);
await p.goto(BASE, { waitUntil: 'load' });
check((await p.title()) === 'Cashfra v2', `next launch serves the new build offline (${await p.title()})`);
const s3 = await state();
check(s3.caches.length === 1, `still exactly one cache: ${s3.caches}`);
await ctx.setOffline(false);

await b.close();
cleanup();
console.log(ok.map(s => '  PASS  ' + s).join('\n'));
if (bad.length) { console.log('\n' + bad.map(s => '  FAIL  ' + s).join('\n')); process.exit(1); }
console.log(`\n${ok.length} checks passed`);
