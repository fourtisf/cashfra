#!/usr/bin/env node
/* Cashfra sync — one ledger, several devices, ALFA's own server.
 *
 * Holds one JSON blob per token and nothing else: no accounts, no database, no
 * third party. The blob is whatever the app sends, so this file never needs to
 * understand the ledger and never changes when the ledger does.
 *
 *   PORT=8787 DATA_DIR=/var/lib/cashfra node deploy/sync-server.js
 *
 * Tokens are created by writing a file: /var/lib/cashfra/<token>.json
 * deploy/vps-sync-setup.sh does all of this, including the nginx location.
 *
 * Concurrency: every write carries the version it was based on. A write based
 * on a stale version is refused with 409 and the current blob, so the client
 * merges and retries instead of overwriting a device it never saw.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DIR = process.env.DATA_DIR || '/var/lib/cashfra';
const MAX = 8 * 1024 * 1024;          // a ledger is text; 8MB is years of it

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

/* a token names a file, so it must not be able to name a different one */
const clean = t => (/^[A-Za-z0-9_-]{16,128}$/.test(t || '') ? t : null);
const file = t => path.join(DIR, t + '.json');

function send(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': process.env.ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Cashfra-Token,X-Cashfra-Version',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS'
  });
  res.end(s);
}

function read(token) {
  try {
    return JSON.parse(fs.readFileSync(file(token), 'utf8'));
  } catch (e) {
    return { version: 0, at: 0, data: null };
  }
}

function write(token, rec) {
  /* write beside, then rename: a half-written ledger never exists on disk */
  const tmp = file(token) + '.' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file(token));
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const token = clean(req.headers['x-cashfra-token']);
  if (!token) return send(res, 401, { error: 'bad token' });
  /* the token must already exist — this server never opens accounts */
  if (!fs.existsSync(file(token))) return send(res, 401, { error: 'unknown token' });

  if (req.method === 'GET') {
    const rec = read(token);
    return send(res, 200, { version: rec.version, at: rec.at, data: rec.data });
  }

  if (req.method !== 'PUT') return send(res, 405, { error: 'GET or PUT' });

  let body = '', over = false;
  req.on('data', c => {
    body += c;
    if (body.length > MAX && !over) { over = true; send(res, 413, { error: 'too large' }); req.destroy(); }
  });
  req.on('end', () => {
    if (over) return;
    let incoming;
    try { incoming = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!incoming || typeof incoming.data !== 'object' || incoming.data === null)
      return send(res, 400, { error: 'no data' });

    const cur = read(token);
    const base = +incoming.base;
    if (!(base === cur.version))
      /* someone else moved first — hand back what is there and let them merge */
      return send(res, 409, { error: 'stale', version: cur.version, at: cur.at, data: cur.data });

    const rec = { version: cur.version + 1, at: Date.now(), data: incoming.data };
    write(token, rec);
    send(res, 200, { version: rec.version, at: rec.at });
  });
}).listen(PORT, HOST, () => {
  console.log('cashfra sync on http://' + HOST + ':' + PORT + ' · data in ' + DIR);
});
