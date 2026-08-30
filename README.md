# Cashfra

ALFA's private bookkeeping app for the token-listing business — money in, money
out, per-person commissions, receivables, recurring costs and growth analytics,
across brands, behind a PIN.

This repo is the deployable version of the approved prototype. The app itself is
still **one file with zero dependencies and no build step** — `index.html`
(the prototype's `cashfra.html`). Everything else here exists so it installs as
a real PWA and opens offline.

Read [`CASHFRA-HANDOFF.md`](CASHFRA-HANDOFF.md) before changing app code: it
documents the data model and the business rules that must not change.

## What's in here

| File | Why |
| --- | --- |
| `index.html` | The app. Same code as the prototype — the three inline data-URI `<link>` tags now point at real files, and a service-worker registration was appended. Nothing else changed. |
| `manifest.json` | Real web app manifest — the install prompt reads this. |
| `sw.js` | Service worker. Cache-first app shell so it opens offline. |
| `icons/` | 192 and 512 icons, `maskable` variants for Android's adaptive shapes, and the 180px apple-touch-icon. |
| `favicon.ico` | Browser tab icon. |
| `.htaccess` | Apache/Hostinger config: HTTPS redirect, `noindex`, cache rules. |
| `deploy/nginx.conf` | The same rules as an nginx server block, for a VPS. |
| `robots.txt` | Belt and braces on top of the `noindex` header. |
| `bump-version.sh` | Bumps the service-worker cache name. Run before each deploy. |
| `dev-server.py` | Local server that sends the production headers. |
| `test/` | Browser checks for the app and for the deploy handover. |

The 192 and 180 icons are the prototype's own artwork, extracted byte-for-byte
from the data URIs. The 512 and maskable icons are redrawn from the same
geometry (0.2 corner radius, vertical `#7B6CFF → #4335CE`, white C) so they stay
crisp at size. The UI itself is untouched.

## Deploy

### Hostinger (shared hosting)

1. Create the subdomain, e.g. `cashfra.fourtis.io`, and issue the free SSL cert
   for it in hPanel. **HTTPS is not optional** — a service worker will not
   register over plain http.
2. `./bump-version.sh`
3. Upload to the subdomain's `public_html`: `index.html`, `manifest.json`,
   `sw.js`, `favicon.ico`, `robots.txt`, `.htaccess`, `icons/`. Nothing else
   belongs on the server; `.htaccess` blocks the rest if it ends up there.
4. Open the subdomain and walk the checklist under *Verify* below.

### VPS (nginx)

```sh
sudo mkdir -p /var/www/cashfra
sudo rsync -av --delete \
  index.html manifest.json sw.js favicon.ico robots.txt icons/ \
  /var/www/cashfra/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/cashfra
# edit server_name + cert paths, then:
sudo ln -sf /etc/nginx/sites-available/cashfra /etc/nginx/sites-enabled/cashfra
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cashfra.example.com
```

### Redeploying

Always `./bump-version.sh` first — the shell is served cache-first, and the
cache name is what tells installed copies that a new build exists.

The handover is deliberately quiet: the new shell is precached in the
background, the open screen is **never** reloaded out from under you, and the
swap happens the moment the app is backgrounded. The next launch is the new
build. `test/update.mjs` checks exactly this.

> **Do not drop the `Cache-Control: no-cache` header on `sw.js`.** It is
> load-bearing, not decoration. Without it the browser serves `sw.js` from its
> own HTTP cache, never notices the new build, and the app stays frozen on an
> old version indefinitely. Both `.htaccess` and `deploy/nginx.conf` set it;
> `dev-server.py` reproduces it locally. This was confirmed the hard way — with
> a header-less local server, a bumped build never reached the browser at all.

## Verify after deploy

- [ ] `https://…/` loads and PIN **162007** opens it — then change the code in
      Settings → App lock.
- [ ] The app opens on a seeded demo ledger. Once real bookkeeping starts, clear
      it with *Clear and start fresh* on the sample-entries banner (or Your data
      → *Delete all entries*). Both offer an undo.
- [ ] DevTools → Application → Manifest: no errors, icons listed.
- [ ] Application → Service Workers: `sw.js` is *activated and running*.
- [ ] Android Chrome shows *Install app* / *Add to Home screen*; the installed
      icon is the purple C and it opens fullscreen with no address bar.
- [ ] Airplane mode, then relaunch from the home screen — the app opens and all
      data is there.
- [ ] Log an entry, force-quit, reopen — the entry is still there.
- [ ] `curl -sI https://…/ | grep -i x-robots-tag` returns the noindex header.
- [ ] `curl -sI https://…/sw.js | grep -i cache-control` says `no-cache`.

## Data

There is no server, no account and no sync. The ledger lives in `localStorage`
under `fourtis:ledger:v3` on the one device, and the service worker never caches
it — deploys and cache purges cannot touch the numbers. Clearing the browser's
site data *does* wipe it.

**The claude.ai prototype and this deployment are separate stores.** To carry
existing data over: in the prototype, Settings → Backup JSON; in the deployed
app, Settings → Restore. Same procedure for moving between devices, and worth
doing every so often as a backup.

## Local development

```sh
python3 dev-server.py 8000        # http://127.0.0.1:8000
```

Use this rather than `python3 -m http.server` — it sends the same headers as the
real host, so a stale service worker can't quietly mask your changes.
`localhost` counts as a secure origin, so the worker registers there too; keep
DevTools → Application → *Update on reload* ticked while iterating.

Opening `index.html` over `file://` still works — the app falls back to
`localStorage` and simply skips the service worker.

## Tests

Three Playwright suites, 73 checks. They are for this repo only and never ship
to the server. The price feed is always stubbed, so the suites are hermetic.

```sh
cd test && npm install && cd ..

python3 dev-server.py 8123 &            # smoke + rates need a server
BASE=http://127.0.0.1:8123/ node test/smoke.mjs
BASE=http://127.0.0.1:8123/ node test/rates.mjs

node test/update.mjs                    # starts and tears down its own server
```

`smoke.mjs` (51 checks) walks the handoff's regression list on a Pixel viewport:
every head asset resolves, Chrome parses the manifest with no errors, the worker
activates and precaches the full shell, PIN 162007 unlocks, all five panels
render, both mix donuts draw and keep their colours when the filter changes, the
M/W toggle and period nav work, `"2.5 bnb"` parses to 2.5 BNB with the USD locked
at the entry's rate, and an offline relaunch still shows the ledger — with no
console errors anywhere.

`rates.mjs` (15 checks) covers the live price feed: prices land, stablecoin
wobble pins to 1, USD→IDR follows, the call is throttled, the switch and the
manual refresh work — and, the one that matters most, **entries already in the
books keep the rate and USD they were saved with**.

`update.mjs` (7 checks) ships a second build mid-run and verifies the handover
described under *Redeploying*.

Set `CHROME_PATH` if Playwright can't find a browser.
