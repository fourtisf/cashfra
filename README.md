# Cashfra

ALFA's private bookkeeping app for the token-listing business — money in, money
out, per-person commissions, shared costs, recurring costs and growth
analytics, across brands, behind a PIN. Listings are cash in full, up front; the app is built
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

Off by default, and the app is complete without it. Turn it on when the phone
and the laptop need to show the same book.

```sh
sudo bash /opt/cashfra/deploy/vps-sync-setup.sh
```

That is the whole setup. **The access code is the login**: type it on any phone
or laptop and the book is there, type it wrong and there is no way in. It
defaults to 162007, which is what a fresh app seeds, so with no arguments this
just works. A different one: `sudo bash deploy/vps-sync-setup.sh cashfra.com 445566`.

The code never leaves the device. What reaches the server is 200,000 rounds of
PBKDF2 over it. Those numbers live in one place — `sync-server.js`, which the
setup script calls (`--ensure <code>`) rather than repeating them — and
`test/code-login.mjs` compares that against what the browser derives, because a
drift between the two would lock ALFA out of his own book with both sides
looking correct.

`--ensure` also **adopts a book left over from an earlier way in** rather than
starting an empty one beside it: a stranded ledger is a lost one. With several
books and no way to tell which is his, it stops and lists them.

The script creates a `cashfra` system user, a systemd unit for
`deploy/sync-server.js` on a free loopback port (it walks 8787-8799 — the first
version assumed 8787 was free and died on a box where it was not), and an nginx
`location = /sync` in front of it. One exact address carries everything:
reading, writing, and re-keying. An earlier version put signing in under
`/sync/auth/…` and it did not route on a real server — nginx answered 405, which
is what a static handler says to a POST.

It then checks the two answers that matter — the real key gets 200, a made-up
one 401 — and if either is wrong it stops, retries against `127.0.0.1` to say
whether the fault is nginx or the service, and does **not** print instructions.
A check that failed must not read as success.

Then on each device: open the address, type the code. Nothing else. The app is
served from the server it syncs with, so it already knows where to look.

- The server holds **one opaque JSON blob per key** and never parses it, so it
  does not change when the ledger does.
- Merging is **a union by entry id**; the later `mt` wins a field-level clash.
  A device offline for a week can never erase what the other one wrote. The
  honest cost: **a deletion only spreads while the other device is online**,
  because a merge that deletes could eat somebody's work.
- Every write carries the version it was based on. A stale write gets a 409 and
  the current blob, and the loser **merges and retries inside the same
  exchange** — a device that gave up there would sit on its entry until it was
  next edited, silently out of step.
- A device pulls when the app comes back to the foreground, not only on unlock.
- The empty-book card says one thing at a time. It reads the actual state —
  fetching, wrong code for this server, unreachable, or genuinely empty — and
  the screen repaints when a sync fails, so it cannot sit on "Fetching your
  book…" long after the fetch gave up.
- **Changing the code moves the book.** Settings → App lock → Change code
  re-keys the server, so the ledger follows; other devices then need the new
  code. Do not change it by re-running the setup script — that would leave the
  book stranded under the old key, and the script refuses rather than starting
  a second empty one beside it.
- **Guessing is limited**: 20 wrong keys an hour from one address, then blocked.
  A six-digit code is only safe if guessing is not, and this is what makes the
  difference between minutes and years.
- Removing the access code does **not** cut a device off — it already holds the
  key, and continuing to sync is the better behaviour. But a new device joins by
  typing the code, so with it removed there is nowhere left to read it from. The
  panel says so.
- `sw.js` must keep skipping any request carrying `X-Cashfra-Token`. Cache the
  exchange and the app reads a stale version number, every write after it is
  refused, and even a `401` replays as a `200`.

The server also carries an email-and-code sign-in, used by nothing in the app
and off unless `ALLOW` names an address. It exists because it was built, tested
and then made unnecessary; leave it or delete it, but do not wire the app back
to it without a reason.

### Redeploying### Redeploying

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

Ten Playwright suites, 280 checks. They are for this repo only and never ship
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
BASE=http://127.0.0.1:8123/ node test/brands.mjs

node test/update.mjs                    # starts and tears down its own server
node test/sync.mjs                      # and its own sync service
node test/code-login.mjs                # ...and a book keyed by 162007
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

`landing.mjs` (24 checks) covers the lock screen — the page the domain
actually opens on — at 1440px and on a phone at once: the card treatment and
keyboard hint appear on the desktop, the code goes in from the keyboard, no
scrollbar sits behind the lock, the keypad's invisible spacer key stays
invisible, motion is off under `prefers-reduced-motion` without leaving the
card hidden, tapping fast cannot trigger iOS double-tap zoom, and the approved
phone layout is unmoved by any of it.

It also covers the notch and the home indicator, which are invisible in a
desktop browser because the insets are zero there — which is why the header
shipped colliding with ALFA's clock and battery once the app was installed to
his home screen, and the toast landed inside the button bar. The app reads
both through `--sat` / `--sab` rather than `env()` at each site, so the suite
can set them and check that the header, the lock screen, a full-height sheet,
the toast and the bottom button all move clear. A screenshot of one phone is
not a test.

`rules.mjs` (22 checks) covers the three guards that keep the book honest. A
listing opens as *Paid in full*, and changing that by hand is answered with the
reason rather than a silent snap back to Paid — the rule is ALFA's business
fact, not a cage, so it explains and still saves. Trending, which really can be
arranged differently, is left alone. The same deal typed twice is named before
it is saved — matched on client, amount, coin, date and brand, and never
against the entry being edited. And a client opens into every deal they have
done, with *Back* returning to the client list before it leaves the panel.

`brands.mjs` (37 checks) covers the two things a second brand and a team
made necessary. A cost that runs both books — a database, an API key — can be
marked **Shared**, and is then carried by every brand at the share of the money
each one brought in over the same period. The suite logs a real $60 shared cost
and checks that each brand is shown only its slice, that the slices add back to
$60 and no more, that the whole bill still shows with every brand on screen,
and that the brand-vs-brand table says out loud how much of each column is
shared. It also checks the chip is not offered where the idea does not apply:
never on money in, and never on commission, which is earned on one deal under
one brand. The rest opens a person in the Commission panel and reads their
statement against the ledger — earned, owed, one line per deal, the revenue
they touched, and their **effective rate** measured against the default agreed
with them — then copies it as text he can send them.

`update.mjs` (7 checks) ships a second build mid-run and verifies the handover
described under *Redeploying*.

`sync.mjs` (21 checks) runs two browser contexts as two devices against a real
`sync-server.js` on a throwaway data directory, behind a thirty-line stand-in
for nginx so the app and `/sync` share one origin under a live service worker —
the production topology, and the only arrangement in which the worker can be
caught caching the exchange. It checks that typing the access code is the
whole of joining, that a device pushes on its own, that a second device pulls the whole
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

`code-login.mjs` (22 checks) covers the access code being the login. Its first
check is the one that matters most: the browser and the setup script must derive
the same key from the same code, or ALFA is locked out of his own book with both
sides looking correct. Then the shape of it — a second device typing the code and
finding the book, a wrong code opening nothing and bringing nothing down, a key
that was never made refused, guessing cut off after twenty tries, and changing the
code moving the book rather than stranding it. Its stand-in for nginx is routed
the way ALFA's server is: an exact match on `/sync` and nothing beneath it.

Set `CHROME_PATH` if Playwright can't find a browser.
