# Cashfra

ALFA's private bookkeeping app for the token-listing business — money in, money
out, per-person commissions, recurring costs and growth analytics, across
brands, behind a PIN. Listings are cash in full, up front; the app is built
around that and says so when an entry disagrees.

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
| `deploy/sync-server.js` | Optional. ~90 lines of Node that hold one JSON blob per token, so several devices can share one ledger. |
| `deploy/vps-sync-setup.sh` | Turns that on: service user, token, systemd unit, nginx `/sync`, then checks it. |
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

### Sync across devices — optional

Off by default, and the app is complete without it: each device keeps its own
copy in `localStorage`. Turn it on when the phone and the laptop need to show
the same book.

```sh
sudo bash /opt/cashfra/deploy/vps-sync-setup.sh          # prints the token
```

It creates a `cashfra` system user, a token, a systemd unit for
`deploy/sync-server.js` bound to `127.0.0.1:8787`, and an nginx `location =
/sync` in front of it, then checks that the real token gets a 200 and a wrong
one a 401. Re-running it is safe and prints the same token back.

Then on each device: **Menu → Settings → Sync across devices**, enter the
server address it printed (`https://cashfra.com/sync`) and the token, and
**Sync now**. After that it runs on its own, a few seconds after any change.

What it is and is not:

- The server holds **one opaque JSON blob per token** and never parses it, so
  it does not change when the ledger does.
- **The access code never leaves the device.** `lockHash` and `lockSalt` are
  stripped before anything is sent, and so is the token itself — each device
  keeps its own code.
- Merging is **a union by entry id**; the later `mt` wins a field-level clash.
  A device that was offline for a week can never erase what the other one
  wrote. The honest cost: **a deletion only spreads while the other device is
  online**, because a merge that deletes could eat somebody's work.
- Every write carries the version it was based on. A stale write gets a 409
  and the current blob back, and the loser **merges and retries inside the
  same exchange**. A device that gave up there would sit on its entry until
  it was next edited — silently out of step, which is the failure this whole
  feature exists to remove.
- A device **pulls when the app comes back to the foreground**, not only when
  it is unlocked. With the access code removed there is no unlock to hang it
  on, and that device would otherwise only learn of a change by being edited.
- A token names a file, and the file must already exist — the service never
  opens accounts. A second book is `sudo -u cashfra tee
  /var/lib/cashfra/<token>.json <<< '{"version":0,"at":0,"data":null}'`;
  revoking one is `sudo rm` on that file.

> The service worker must not cache the sync exchange — it is live data, not
> shell. `sw.js` skips any request carrying `X-Cashfra-Token`. Without that
> skip the app reads a cached version number, every write after it is refused
> as stale, and a cached `401` even replays as a `200`. `test/sync.mjs` runs
> the app and the endpoint on one origin, under a live worker, precisely so
> that regression fails there instead of on ALFA's phone.

### Redeploying

Always `./bump-version.sh` first — the shell is served cache-first, and the
cache name is what tells installed copies that a new build exists. It stamps
the same number into `index.html`, which the app shows under **Your data →
Version**, so "which build is this phone running" is answerable on the phone
rather than by guessing.

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
- [ ] The app opens on an empty ledger — nothing is invented. Sample entries
      are behind Your data → *Load sample data* if you ever want to see how the
      charts read; *Clear and start fresh* on the banner removes them again.
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
- [ ] Only if sync is on: log an entry on the phone, hit **Sync now** on the
      laptop, and it appears. Then the reverse.

## Data

The ledger lives in `localStorage` under `fourtis:ledger:v3` on the device, and
the service worker never caches it — deploys and cache purges cannot touch the
numbers. Clearing the browser's site data *does* wipe it.

There is no account and no third party. Sync is off unless it is switched on,
and when it is, it talks to ALFA's own VPS and nowhere else — see *Sync across
devices* above.

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

Eight Playwright suites, 213 checks. They are for this repo only and never ship
to the server. The price feed is always stubbed, so the suites are hermetic.

```sh
cd test && npm install && cd ..

python3 dev-server.py 8123 &            # the last two bring their own server
BASE=http://127.0.0.1:8123/ node test/smoke.mjs
BASE=http://127.0.0.1:8123/ node test/rates.mjs
BASE=http://127.0.0.1:8123/ node test/features.mjs
BASE=http://127.0.0.1:8123/ node test/analytics.mjs
BASE=http://127.0.0.1:8123/ node test/landing.mjs
BASE=http://127.0.0.1:8123/ node test/rules.mjs

node test/update.mjs                    # starts and tears down its own server
node test/sync.mjs                      # and its own sync service
```

`smoke.mjs` (52 checks) walks the handoff's regression list on a Pixel viewport:
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

`features.mjs` (41 checks) covers the six later additions: the stale-price hint,
the backup reminder and its download, auto-lock across all three grace settings,
client contacts and their Telegram/X links, the monthly target card, and the
invoice sheet — including that an unpaid deal reads as a *Quotation*, that the
wallet matched to the deal's chain appears, and that the copied text is
pasteable into a chat.

`analytics.mjs` (39 checks) covers the comparison and allocation views, and
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

`rules.mjs` (22 checks) covers the three guards that keep the book honest. A
listing opens as *Paid in full*, and changing that by hand is answered with the
reason rather than a silent snap back to Paid — the rule is ALFA's business
fact, not a cage, so it explains and still saves. Trending, which really can be
arranged differently, is left alone. The same deal typed twice is named before
it is saved — matched on client, amount, coin, date and brand, and never
against the entry being edited. And a client opens into every deal they have
done, with *Back* returning to the client list before it leaves the panel.

`update.mjs` (7 checks) ships a second build mid-run and verifies the handover
described under *Redeploying*.

`sync.mjs` (20 checks) runs two browser contexts as two devices against a real
`sync-server.js` on a throwaway data directory, behind a thirty-line stand-in
for nginx so the app and `/sync` share one origin under a live service worker —
the production topology, and the only arrangement in which the worker can be
caught caching the exchange. It checks that sync is off until a server is
entered, that a device pushes on its own, that a second device pulls the whole
ledger, that neither device's entries are lost to the other's merge, that two
syncs back to back both land, that the access code and the token never reach
the server, and that an unknown token gets a 401.

Two of its checks are about not giving up. One forces the exact race — another
device writing between this device's read and its write — and reads the whole
exchange back, so the pass depends on the refusal being followed by a retry
that lands, not on a later background sync quietly rescuing the result. The
other removes the access code from one device and checks that merely
reopening the app is enough to pick the other's work up. Both were written
against the fixed code, then re-run with the fix removed: an assertion nobody
has watched fail is not yet a test, and the first version of the race check
passed either way.

Set `CHROME_PATH` if Playwright can't find a browser.
