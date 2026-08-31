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
| `deploy/bootstrap.sh` | First time on a server: key, clone and deploy, in one run. |
| `deploy/vps-setup.sh` | One-command deploy to an Ubuntu VPS, then checks the result. |
| `deploy/vps-update.sh` | Pull the latest and redeploy, in one command. |
| `deploy/nginx.conf` | The nginx site it installs (certbot adds TLS to it). |
| `deploy/upload-ftp.sh` · `.ps1` | The same, for shared hosting with only FTP. |
| `robots.txt` | Belt and braces on top of the `noindex` header. |
| `bump-version.sh` | Bumps the service-worker cache name. Run before each deploy. |
| `dev-server.py` | Local server that sends the production headers. |
| `test/` | Browser checks for the app and for the deploy handover. |

The 192 and 180 icons are the prototype's own artwork, extracted byte-for-byte
from the data URIs. The 512 and maskable icons are redrawn from the same
geometry (0.2 corner radius, vertical `#7B6CFF → #4335CE`, white C) so they stay
crisp at size. The UI itself is untouched.

## Deploy

### Hostinger — cashfra.com

In hPanel first, once: attach `cashfra.com` to the hosting plan, then
**Security → SSL** and issue the free certificate. **HTTPS is not optional** —
a service worker will not register over plain http. Collect the FTP host and
username from **Files → FTP Accounts**.

Then, from the folder holding `index.html`:

```sh
./bump-version.sh
./deploy/upload-ftp.sh <ftp-host> <ftp-user>          # bash / WSL / Git Bash / macOS
```

```powershell
# Windows PowerShell — curl.exe ships with Windows 10 and 11
powershell -ExecutionPolicy Bypass -File deploy\upload-ftp.ps1 `
  -FtpHost <ftp-host> -User <ftp-user>
```

Both upload an explicit list — `index.html`, `manifest.json`, `sw.js`,
`favicon.ico`, `robots.txt`, `.htaccess`, `icons/` — so running them from the
repo root never pushes `README.md`, `test/` or `.git` to the site. Both refuse
to waste a deploy on an unbumped cache name, and both check the result
afterwards: HTTPS 200, the `no-cache` header on `sw.js`, the noindex header,
and that the new build is really the one being served.

Uploading by hand instead? Same file list into `public_html`, and turn on
"show hidden files" in File Manager or `.htaccess` will be silently left
behind — which costs you the `no-cache` header, and with it every future
update.

### VPS (Ubuntu + nginx) — the main path

Point the domain's A record at the server first. Then do everything **on the
server** — pulling from GitHub means there is no file to move from a laptop and
no second shell to confuse it with.

First time on a server, `deploy/bootstrap.sh` does the whole thing: makes a
key, waits while you paste it into the repo's deploy keys, clones, and deploys.
Paste it in as a file and run it — a script read from the terminal would eat
its own `read` prompt, and it refuses to run that way rather than misbehave.

Adding the key on GitHub is the one step that cannot be automated, so the
script stops and waits for it instead of failing three commands later.

After that, every update is:

```sh
sudo bash /opt/cashfra/deploy/vps-update.sh
```

A deploy key is read-only and scoped to this one repository, and nothing secret
is ever typed into the shell — unlike a token in the clone URL, which lands in
`.git/config` and in shell history.

The cache name is bumped **in the repo and committed**, never on the server:
bumping there would dirty the checkout and block the next fast-forward pull.

`vps-setup.sh` installs nginx and certbot if they are missing, refuses to
continue when something other than nginx holds port 80 or when the domain does
not resolve to this machine, publishes to `/var/www/cashfra` as `www-data`,
installs the site, runs certbot, and then checks what actually landed.

The previous build is kept at `/var/www/cashfra.prev`, so a rollback is one
move:

```sh
sudo rm -rf /var/www/cashfra && sudo mv /var/www/cashfra.prev /var/www/cashfra
sudo systemctl reload nginx
```

Only the app is published: no `.md`, no `deploy/`, no `test/`, no `.git`.

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

- [ ] `https://cashfra.com/` loads and PIN **162007** opens it — then change the code in
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
- [ ] `curl -sI https://cashfra.com/ | grep -i x-robots-tag` returns the noindex header.
- [ ] `curl -sI https://cashfra.com/sw.js | grep -i cache-control` says `no-cache`.
      (the deploy scripts check both for you)

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

Six Playwright suites, 156 checks. They are for this repo only and never ship
to the server. The price feed is always stubbed, so the suites are hermetic.

```sh
cd test && npm install && cd ..

python3 dev-server.py 8123 &            # all but the deploy suite need a server
BASE=http://127.0.0.1:8123/ node test/smoke.mjs
BASE=http://127.0.0.1:8123/ node test/rates.mjs
BASE=http://127.0.0.1:8123/ node test/features.mjs
BASE=http://127.0.0.1:8123/ node test/analytics.mjs
BASE=http://127.0.0.1:8123/ node test/landing.mjs

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

`features.mjs` (34 checks) covers the six later additions: the stale-price hint,
the backup reminder and its download, auto-lock across all three grace settings,
client contacts and their Telegram/X links, the monthly target card, and the
invoice sheet — including that an unpaid deal reads as a *Quotation*, that the
wallet matched to the deal's chain appears, and that the copied text is
pasteable into a chat.

`analytics.mjs` (30 checks) covers the comparison and allocation views, and
checks the arithmetic against the ledger rather than just that a section
appeared: money in matches, the cost bars total the real cost ratio when
switched to share-of-income, a cap is measured against money in and flagged
when breached, the brand table shows the other brand's own figures while you
are viewing one, and a client's headline number is net of commission. It also
reads the *painted* colour of each delta, not the class name — a more specific
rule further down the stylesheet had quietly greyed all of them out.

`landing.mjs` (17 checks) covers the lock screen — the page the domain
actually opens on — at 1440px and on a phone at once: the card treatment and
keyboard hint appear on the desktop, the code goes in from the keyboard, no
scrollbar sits behind the lock, the keypad's invisible spacer key stays
invisible, motion is off under `prefers-reduced-motion` without leaving the
card hidden, tapping fast cannot trigger iOS double-tap zoom, and the approved
phone layout is unmoved by any of it.

`update.mjs` (7 checks) ships a second build mid-run and verifies the handover
described under *Redeploying*.

Set `CHROME_PATH` if Playwright can't find a browser.
