#!/usr/bin/env node
/* Cashfra sync — one ledger, several devices, ALFA's own server.
 *
 * Holds one JSON blob per token and nothing else: no database, no third party.
 * The blob is whatever the app sends, so this file never needs to understand
 * the ledger and never changes when the ledger does.
 *
 *   PORT=8787 DATA_DIR=/var/lib/cashfra node deploy/sync-server.js
 *
 * Signing in is email plus a six-digit code, and all it does is hand back the
 * token the sync has always used — so the part that was tested stays exactly
 * as it was, and ALFA never sees a token again.
 *
 * Only addresses in ALLOW can sign in; there is no sign-up. Everything else
 * about that decision is in the README.
 *
 * Concurrency: every write carries the version it was based on. A write based
 * on a stale version is refused with 409 and the current blob, so the client
 * merges and retries instead of overwriting a device it never saw.
 */
'use strict';
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DIR = process.env.DATA_DIR || '/var/lib/cashfra';
const ACC = path.join(DIR, 'accounts');
const PEND = path.join(DIR, 'codes');
const MAX = 8 * 1024 * 1024;          // a ledger is text; 8MB is years of it

const CODE_TTL = 10 * 60e3;           // long enough to switch apps and come back
const CODE_TRIES = 5;                 // six digits is only safe if guessing is not
const START_MAX = 5, START_WIN = 60 * 60e3;

const ALLOW = String(process.env.ALLOW || '').split(',')
  .map(s => s.trim().toLowerCase()).filter(Boolean);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(ACC, { recursive: true, mode: 0o700 });
fs.mkdirSync(PEND, { recursive: true, mode: 0o700 });

/* a token names a file, so it must not be able to name a different one */
const clean = t => (/^[A-Za-z0-9_-]{16,128}$/.test(t || '') ? t : null);
const file = t => path.join(DIR, t + '.json');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const okEmail = e => /^[^@\s]{1,64}@[^@\s]{3,255}\.[A-Za-z]{2,}$/.test(e || '');
const norm = e => String(e || '').trim().toLowerCase();

function send(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': process.env.ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Cashfra-Token,X-Cashfra-Version',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
  });
  res.end(s);
}

function readJson(req, res, cb) {
  let body = '', over = false;
  req.on('data', c => {
    body += c;
    if (body.length > MAX && !over) { over = true; send(res, 413, { error: 'too large' }); req.destroy(); }
  });
  req.on('end', () => {
    if (over) return;
    let j;
    try { j = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    cb(j);
  });
}

function readRec(token) {
  try { return JSON.parse(fs.readFileSync(file(token), 'utf8')); }
  catch (e) { return { version: 0, at: 0, data: null }; }
}

/* write beside, then rename: a half-written file never exists on disk */
function writeAtomic(p, obj) {
  const tmp = p + '.' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function readAny(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* ── mail ──────────────────────────────────────────────────────────────────
   Three ways out, because a VPS has no opinion about which one ALFA has.
   `file` is the fallback rather than an error: a code nobody can read is a
   dead end, and dropping it in a directory at least leaves a way in. */
const MAIL = String(process.env.MAIL_MODE || 'file').toLowerCase();

function mailFile(to, subject, text) {
  const dir = process.env.MAIL_DIR || path.join(DIR, 'outbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, sha(norm(to)).slice(0, 16) + '.txt'),
    'To: ' + to + '\nSubject: ' + subject + '\n\n' + text + '\n', { mode: 0o600 });
  return Promise.resolve();
}

/* SMTP over implicit TLS (port 465). No STARTTLS negotiation to get wrong,
   and it is what Gmail app passwords want anyway. */
function mailSmtp(to, subject, text) {
  const host = process.env.SMTP_HOST, port = +(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;
  if (!host || !user || !pass) return Promise.reject(new Error('SMTP_HOST/USER/PASS not set'));

  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host,
      rejectUnauthorized: process.env.SMTP_INSECURE !== '1' });
    let buf = '', waiting = null, done = false;
    const fail = e => { if (done) return; done = true; try { sock.destroy(); } catch (x) {} reject(e); };
    const timer = setTimeout(() => fail(new Error('smtp timed out')), 20000);

    sock.setEncoding('utf8');
    sock.on('error', fail);
    sock.on('data', chunk => {
      buf += chunk;
      /* a reply ends on a line whose code is followed by a space, not a dash */
      const m = buf.match(/^\d{3} [^\n]*\n/m);
      if (!m || !waiting) return;
      const reply = buf; buf = '';
      const w = waiting; waiting = null;
      w(reply);
    });
    const say = (line, expect) => new Promise((res2, rej2) => {
      waiting = reply => {
        const code = +reply.slice(0, 3);
        if (expect.indexOf(code) < 0) return rej2(new Error('smtp said: ' + reply.trim().split('\n')[0]));
        res2(reply);
      };
      if (line !== null) sock.write(line + '\r\n');
    });
    const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
    /* dots at the start of a line end the message; SMTP wants them doubled */
    const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const msg = [
      'From: ' + from, 'To: ' + to,
      'Subject: ' + subject,
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '', body
    ].join('\r\n');

    say(null, [220])
      .then(() => say('EHLO cashfra', [250]))
      .then(() => say('AUTH LOGIN', [334]))
      .then(() => say(b64(user), [334]))
      .then(() => say(b64(pass), [235]))
      .then(() => say('MAIL FROM:<' + from + '>', [250]))
      .then(() => say('RCPT TO:<' + to + '>', [250, 251]))
      .then(() => say('DATA', [354]))
      .then(() => say(msg + '\r\n.', [250]))
      .then(() => say('QUIT', [221]).catch(() => {}))
      .then(() => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (e) {} resolve(); })
      .catch(e => { clearTimeout(timer); fail(e); });
  });
}

function mailResend(to, subject, text) {
  const key = process.env.RESEND_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) return Promise.reject(new Error('RESEND_KEY/MAIL_FROM not set'));
  const https = require('https');
  const payload = JSON.stringify({ from, to: [to], subject, text });
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: process.env.RESEND_HOST || 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(payload) }
    }, resp => {
      let b = ''; resp.on('data', c => b += c);
      resp.on('end', () => resp.statusCode < 300 ? resolve()
        : reject(new Error('resend said ' + resp.statusCode + ' ' + b.slice(0, 200))));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

function sendMail(to, subject, text) {
  const f = MAIL === 'smtp' ? mailSmtp : MAIL === 'resend' ? mailResend : mailFile;
  return f(to, subject, text).catch(e => {
    console.error('mail failed (' + MAIL + '): ' + e.message);
    throw e;
  });
}

/* ── accounts ──────────────────────────────────────────────────────────────
   An account is an email holding a token. Signing in on a third device finds
   the same account, so it finds the same book — which is the entire point. */
function accountFor(email) {
  const p = path.join(ACC, sha(email) + '.json');
  let a = readAny(p);
  if (a && clean(a.token) && fs.existsSync(file(a.token))) return a;
  const token = crypto.randomBytes(24).toString('base64').replace(/[=+/]/g, '').slice(0, 32);
  a = { email, token, created: Date.now() };
  if (!fs.existsSync(file(token)))
    writeAtomic(file(token), { version: 0, at: 0, data: null });
  writeAtomic(p, a);
  return a;
}

/* Every signed-in device holds the same token, so there is no per-device
   revoke — losing a phone means moving the whole account to a new token and
   signing the others in again. The ledger moves with it: an account whose
   book stayed behind under the old token would be a lost book, which is the
   one outcome this file exists to prevent. */
function rotate(email) {
  email = norm(email);
  const p = path.join(ACC, sha(email) + '.json');
  const a = readAny(p);
  if (!a || !clean(a.token)) { console.error('no account for ' + email); process.exit(1); }
  const token = crypto.randomBytes(24).toString('base64').replace(/[=+/]/g, '').slice(0, 32);
  const from = file(a.token), to = file(token);
  if (fs.existsSync(from)) fs.renameSync(from, to);
  else writeAtomic(to, { version: 0, at: 0, data: null });
  writeAtomic(p, { email, token, created: a.created || Date.now(), rotated: Date.now() });
  const rec = readRec(token);
  console.log('rotated ' + email + ' — the book moved with it (version ' + rec.version + ', ' +
    ((rec.data && rec.data.tx || []).length) + ' entries).');
  console.log('Every device must sign in again; none of them can reach it with the old token.');
}
if (process.argv[2] === '--rotate') { rotate(process.argv[3]); process.exit(0); }

function authStart(req, res) {
  readJson(req, res, j => {
    const email = norm(j && j.email);
    if (!okEmail(email)) return send(res, 400, { error: 'That does not look like an email address' });
    /* Say plainly that an address is not allowed. This is one person's private
       server, and a silent "check your inbox" for mail that will never arrive
       is a worse failure than admitting the address is not on the list. */
    if (ALLOW.indexOf(email) < 0)
      return send(res, 403, { error: 'This server does not accept that address' });

    const p = path.join(PEND, sha(email) + '.json');
    const cur = readAny(p) || {};
    const now = Date.now();
    const starts = (cur.starts || []).filter(t => now - t < START_WIN);
    if (starts.length >= START_MAX)
      return send(res, 429, { error: 'Too many codes requested. Try again in an hour.' });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const salt = crypto.randomBytes(8).toString('hex');
    starts.push(now);
    writeAtomic(p, { hash: sha(salt + ':' + code), salt, exp: now + CODE_TTL, tries: 0, starts });

    sendMail(email, 'Cashfra sign-in code: ' + code,
      'Your Cashfra sign-in code is ' + code + '\n\n' +
      'It works for ten minutes, on one device.\n' +
      'If you did not ask for it, someone typed your address into a Cashfra ' +
      'sign-in screen. Nothing has happened, and nothing will without this code.')
      .then(() => send(res, 200, { ok: true, sent: MAIL === 'file' ? 'file' : MAIL }))
      .catch(() => send(res, 502, { error: 'The server could not send the email. Check its mail settings.' }));
  });
}

function authVerify(req, res) {
  readJson(req, res, j => {
    const email = norm(j && j.email), code = String((j && j.code) || '').trim();
    if (!okEmail(email) || !/^\d{6}$/.test(code))
      return send(res, 400, { error: 'Enter the six digits from the email' });

    const p = path.join(PEND, sha(email) + '.json');
    const cur = readAny(p);
    if (!cur || !cur.hash) return send(res, 401, { error: 'Ask for a new code' });
    if (Date.now() > cur.exp) { try { fs.unlinkSync(p); } catch (e) {} return send(res, 401, { error: 'That code has expired' }); }
    if (cur.tries >= CODE_TRIES) return send(res, 429, { error: 'Too many wrong tries. Ask for a new code.' });

    const a = Buffer.from(sha(cur.salt + ':' + code));
    const b = Buffer.from(cur.hash);
    const good = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!good) {
      cur.tries++;
      writeAtomic(p, cur);
      return send(res, 401, { error: 'That code is not right (' + (CODE_TRIES - cur.tries) + ' left)' });
    }
    try { fs.unlinkSync(p); } catch (e) {}
    const acc = accountFor(email);
    send(res, 200, { token: acc.token, email: acc.email });
  });
}

/* ── the ledger itself, unchanged ──────────────────────────────────────────*/
function ledger(req, res) {
  const token = clean(req.headers['x-cashfra-token']);
  if (!token) return send(res, 401, { error: 'bad token' });
  /* the token must already exist — signing in is the only thing that makes one */
  if (!fs.existsSync(file(token))) return send(res, 401, { error: 'unknown token' });

  if (req.method === 'GET') {
    const rec = readRec(token);
    return send(res, 200, { version: rec.version, at: rec.at, data: rec.data });
  }
  if (req.method !== 'PUT') return send(res, 405, { error: 'GET or PUT' });

  readJson(req, res, incoming => {
    if (!incoming || typeof incoming.data !== 'object' || incoming.data === null)
      return send(res, 400, { error: 'no data' });
    const cur = readRec(token);
    if (+incoming.base !== cur.version)
      /* someone else moved first — hand back what is there and let them merge */
      return send(res, 409, { error: 'stale', version: cur.version, at: cur.at, data: cur.data });
    const rec = { version: cur.version + 1, at: Date.now(), data: incoming.data };
    writeAtomic(file(token), rec);
    send(res, 200, { version: rec.version, at: rec.at });
  });
}

/* The mount point belongs to nginx, not to this file: strip it so the same
   server works at /sync, at / , or anywhere else it is put. */
function route(pathname) {
  let p = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/sync') return '/';
  if (p.indexOf('/sync/') === 0) p = p.slice(5);
  return p || '/';
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const p = route(url.pathname);

  if (p === '/auth/start') return req.method === 'POST' ? authStart(req, res) : send(res, 405, { error: 'POST' });
  if (p === '/auth/verify') return req.method === 'POST' ? authVerify(req, res) : send(res, 405, { error: 'POST' });
  if (p === '/') return ledger(req, res);
  send(res, 404, { error: 'not found' });
}).listen(PORT, HOST, () => {
  console.log('cashfra sync on http://' + HOST + ':' + PORT + ' · data in ' + DIR);
  console.log('mail: ' + MAIL + ' · ' + (ALLOW.length ? ALLOW.length + ' address(es) may sign in' : 'NOBODY may sign in — set ALLOW'));
});
