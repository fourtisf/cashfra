# CASHFRA — Handoff for Claude Code

Owner: ALFA · Prototype built and approved in claude.ai · This doc + `cashfra.html` is everything you need.

## What this is

Cashfra is ALFA's private bookkeeping app for his token-listing business, covering multiple brands (currently **Fourtis** and **Dexvra**, user-extensible). It tracks money in (listing packages paid in SOL/BNB/ETH/TRX/USDT/USDC/IDR), money out, per-person team commissions, receivables, recurring costs, and growth analytics — behind a PIN lock screen.

The prototype is a **complete, working, single-file app**: `cashfra.html` (~110 KB, zero dependencies, vanilla ES5-style JS, no build step). Every feature listed below is implemented and regression-tested. **The UI design is final and owner-approved — do not redesign it.**

## Your job

> **Status:** 1 and 2 are done — see `README.md` for the deploy steps, the PWA
> layout and how to run the tests. 3 (Capacitor/APK) is still untouched. Later
> work added: live token prices, package & chain mix donuts, an X API cost
> category, auto-lock, a backup reminder, client contacts, invoices/quotations
> and a monthly target. The rules below still govern all of it.

1. **Deploy it** on ALFA's hosting (Hostinger/VPS) at a private subdomain, HTTPS required (e.g. `cashfra.fourtis.io`). It must work well on Android Chrome via "Add to Home screen" (meta tags + data-URI icons are already embedded).
2. **Production-harden the PWA** (recommended, not a rewrite):
   - Extract the inline data-URI manifest/icons into real `manifest.json` + icon files.
   - Add a minimal service worker (cache-first for the single HTML) so it opens offline and Chrome shows the install prompt.
3. **Optional / later:** wrap in Capacitor for an APK. The HTML drops into `www/` unchanged — the storage layer already falls back to `localStorage` outside claude.ai.

Keep it a single file if practical; splitting into html/css/js is fine, but preserve behavior exactly.

## Architecture (read before touching anything)

- One IIFE. Global state object `S`, persisted as one JSON blob.
- **Storage adapter `ST`** (top of script): uses `window.storage` (claude.ai artifact API) when present, else a `localStorage` shim with the same promise interface, else null (no persistence). Storage key: `fourtis:ledger:v3` (legacy `:v2` is migrated on first load).
- `load()` → migrations/normalization → PIN gate → `startApp()` → `render()`.
- All rendering is string-built innerHTML with `esc()` for user data. Event handling is mostly delegation on `document` via `data-*` attributes.
- `save()` is debounced 250 ms.

## Data model

```js
S = {
  v:3, tx:[Entry], brands:['Fourtis','Dexvra'], brand:'Fourtis',   // brand = current view ('' = All)
  pkgs:[['Xpress Listing',0],...],        // money-in quick buttons; price 0 = user types amount
  team:[['Michael',15],['Shiller 1',10]], // name + default commission %
  rates:[['SOL',190],...], chains:[...], idr:16300,
  rateAuto:true, rateAt:0,                 // live prices: on/off + last check (ms)
  bkAt:0,                                  // last backup taken (ms) — drives the reminder
  goal:0,                                  // monthly money-in target, 0 = card hidden
  caps:[['Tip shiller',5],...],            // spending ceiling per category, % of money in
  seedFix:'1',                             // marker: the one-time sample-data sweep has run
  lockIdle:300,                            // seconds away before the code is asked again; -1 = never
  contacts:{ '$SOLCAT':'@handle' },        // keyed by client name, beside the ledger
  wallets:[['SOL','addr'],...], invNote:'',// invoice: where they pay, and the terms line
  per:'m'|'w', last:{tok,ch}, lastB, demo, recSkip,
  lockHash, lockSalt, lockLen, lockNum, lockPreset               // access code
}

Entry = {
  id, brand, date:'YYYY-MM-DD', type:'in'|'out', cat, pkg, chain, party,
  amt, tok, rate, usd,                    // usd = amt*rate, LOCKED at entry time
  status:'paid'|'dp'|'unpaid', paid,      // income only; paid = USD received so far
  coms:[{to, pct, usd, paid:bool}],       // commission, multiple recipients; pct is source of truth
  link, hash, note, recur:bool
}
```

## Business logic that MUST NOT change

These rules encode how ALFA runs his books. Breaking any of them silently corrupts his numbers.

1. **USD is locked per entry.** `usd = amt × rate` at the entry's date. Never revalue old entries with current prices. Live prices (`fetchRates`) write only `S.rates` and `S.idr`, which *prefill* the rate box on a new entry — they must never touch `t.rate` or `t.usd` on a saved one. `test/rates.mjs` asserts this.
2. **Listings are cash, in full, up front.** ALFA's listing packages are never
   paid in instalments and never on credit — there is no such thing as a client
   who owes him for a listing. The `status`/`paid` machinery below still exists,
   because other lines (trending, banner, broadcast) can be arranged differently,
   but a listing entry starts and stays **Paid in full**, and anything showing a
   listing as owed is a data-entry mistake, not a receivable to chase.
   In code: `CASH_ONLY` and `cashOnly()`. Choosing the category sets the
   default; a status changed by hand afterwards is answered with `#cashWarn`
   and still saved. Do **not** turn that warning into a block — the rule is a
   business fact, and an entry box that silently snaps back only reads as
   broken. `test/rules.mjs` holds both halves.
3. **A cost can belong to every brand at once.** `brand === SHARED` (`'*'`) instead of a brand name. Viewing one brand, `alloc()` shows only that brand's slice, weighted by `shareOf()` — that brand's share of the money *received* over the same period, falling back to an even split when nothing came in anywhere. The clone `alloc()` returns is for display and arithmetic only; every edit still finds the real entry by id, and `amt` is left whole because one payment was made, not a fraction of one. Commission is in `NOT_SHARED`: it is earned on one deal under one brand, and sharing it would quietly break rule 6's netting.
4. **Received vs booked.** `recv(t)`: unpaid→0, dp→`paid`, paid→`usd`. Money-in totals (`gi`) use *received*. Receivables (`pi`) = Σ(usd − recv) on income.
5. **Commission is per-recipient.** In the form, **% is the source of truth** — USD is derived (`deal usd × pct/100`) and shown read-only. Typing a team member's name auto-fills their default %. Multiple recipients per deal are supported.
6. **Commission never double-counts** — the subtlest rule. Two ways to log a commission exist: (a) inside the income entry (`coms[]`, accrual) and (b) as a money-out entry with category **`Team commission`** (payout). Reconciliation is per person name, in `totals()` and `comBook()`:
   - `A` = accrued (Σ coms.usd on income), `M` = accruals marked paid, `P` = Σ Team-commission expenses to that name.
   - cost = `max(A, P)` · credit = `min(A, max(P, M))` · owed = `A − credit`.
   - **`Team commission` expenses are EXCLUDED from `go` (Money out)** — they settle the accrual, they are not a new cost. Verified invariant: paying out a tracked commission leaves net profit unchanged.
7. **Period engine.** `per='m'|'w'`; weeks start **Monday** (`weekStart`). `periodTx(offset)` drives everything visible (hero, deltas, streak, list, insights, recap). `monthOnlyTx()` is intentionally month-based regardless of view — used by the Team-bonus %-of-income quick calc and the monthly CSV export. Recurring reminders are also calendar-month based.
8. **Growth deltas.** vs previous period: % when previous > 0, absolute $ otherwise (avoids nonsense % across sign changes). For Money out and Commission chips the color logic is inverted (increase = red).
9. **Brand scoping.** Every query filters by `brandView` ('' = All) through `inScope`, which also lets `SHARED` entries through; the numeric paths then run them past `alloc`/`sc` (see rule 3). Entries carry `brand`; renaming a brand in Settings does **not** retag old entries (accepted limitation).
10. **Recurring** = one expected copy per calendar month, keyed `brand|cat|party`; banner offers one-tap logging with undo.
11. **A ledger is never invented.** `load()` opens on an empty book — nothing is seeded on first run. Sample entries exist only behind Your data → *Load sample data*, and only while the ledger is empty. An earlier build seeded them automatically, so `load()` sweeps them once per device, guarded by `seedFix` and by `demo===true` — which is only still true while every entry is untouched sample data, so real work is never in scope.
12. **Invoices are a view, never data.** `invHtml`/`invText` are derived from an entry every time — no invoice is stored, and the document number (`invNo`) is a pure function of brand + date + id, so the same deal always produces the same number. An entry with `status:'unpaid'` is a **Quotation**; anything else is an **Invoice**. Nothing about this writes to the Entry.
13. **Access code.** Preset **162007**, seeded once via marker `lockPreset='162007-v1'` (salt `'fs1'`, hash = SHA-256(`salt:code`), FNV-1a fallback where `crypto.subtle` is unavailable). PIN pad shows when `lockNum`; auto-submits at `lockLen` digits. Change/remove in Settings → App lock. "Forgot" = wipe everything + reseed 162007. This is **client-side deterrence, not security** — the owner knows; don't pretend otherwise, and don't remove it.

## Feature inventory (regression checklist)

PIN gate (setup/lock/change/forgot, auto-lock on leaving with a grace period) · brand switcher + inline "New brand" · M/W toggle with 12-bucket strip, ‹›/arrow-key nav, jump-to-period · animated net + growth pills + streak · delta lines on chips · notices (receivables filter, recurring one-tap log w/ undo) · entry form (brand chips, package chips, centered amount w/ "2.5 bnb" parsing, token pills, auto-rate, chain pills, Team-bonus % quick calc, multi-recipient commission with owed-hint "use this amount", announcement link with Open ↗, status/partial, recurring switch) · edit/delete+undo/duplicate/save-&-add-more · search + filters · Commission panel (netted book, per-person Mark-all-paid, per-recipient per-deal toggles, payouts list) · Insights (**day-by-day cash-flow calendar**, break-even day, biggest-client share, deal-size spread, composition bars with a %-of-spend / %-of-money-in toggle, spending caps vs actual, **period-vs-period comparison** per category with 6-period sparklines, **brand vs brand** table, package & chain mix donuts with a this-period/all-time toggle, package profitability + margin, cost ratio vs prev, avg deal, run-rate) · Clients (net of commission, repeat rate, contacts) · recap ✨ stories · CSV month/all (20 cols incl. Brand, Announce link) · build number + offline-cache state under Your data · JSON backup/restore + overdue reminder + OS share · invoice/quotation sheet (copy text, print to PDF) · client contacts · **tap a client to open their whole history** (Back returns to the list first) · monthly target card · **tap a person in Commission for their statement** (every deal, effective rate vs their default, share of the pot, six-period trend, copy as text) · **shared costs** — a money-out entry marked *Shared* is carried by every brand, split by each one's share of the money in, with its own Insights section and a line in the brand table · **duplicate-entry warning** before saving (client + amount + coin + date + brand) · **cash-only warning** on a listing that is not settled · **email sign-in** (Settings → Sign in) with a prompt on an empty unsigned device · sample data on request (never seeded) + wipe w/ undo · keyboard: n, /, Enter, Esc, arrows.

If you refactor, walk this list on mobile viewport before shipping.

## Known limitations (by design — do not "fix" without asking ALFA)

- claude.ai storage and standalone localStorage are **separate stores**; migration is manual via Backup/Restore JSON.
- Run-rate is a linear projection; noisy early in a period.
- The monthly target is one global number, not per brand, and only shows in month view.
- The day-by-day calendar is month view only; a week grid would say nothing a list does not.
- Spending caps match on the exact category name; a typo silently never matches.
- The brand table deliberately ignores `brandView` — comparing brands is the whole point of it.
- Comparison rows bucket by category, and take commission from `totals().gc` so the netting rule in business rule 6 stays the single source of truth for it.
- A shared cost is split by money **received** in the same period, so the same bill can land differently in two different months. That is the point — it follows the work — but it means a brand's past figures move if an old income entry is corrected.
- Client contacts are keyed by the client's name: rename a client and the contact does not follow.
- The notch and the home indicator are read through `--sat` / `--sab`, defined once on `:root` from `env(safe-area-inset-*)`. Use those variables, never `env()` inline — a test can set a variable and cannot set an env(), and this shipped broken precisely because nothing could check it. Watch the phone media query especially: it once re-declared `.app{padding:0 14px 138px}` and silently undid the fix on the only screens that needed it.
- Tappable controls carry `touch-action:manipulation`; without it iOS Safari reads a fast six-digit code entry as double-tap-to-zoom. Pinch zoom is untouched.
- Leaving the app always covers the screen (so the Android app-switcher snapshot is safe); `lockIdle` only decides whether the code is asked for again on return.
- Live prices come from CoinGecko's free endpoint, at most once every 30 min, and fail silently when offline — the last known prices stay. Only symbols in the `COINS` map are looked up; anything else stays manual.
- The mix donuts hand out six colour slots by an entity's position in `CATS.in` / `S.chains`, never by rank. Anything past the sixth folds into one grey "Other".
- IDR display rate follows the price feed while auto-update is on (it rides on `tether.idr`); switch auto off in Settings to pin it by hand.
- **The access code IS the login.** `tokenFromCode()` in the app and the `node -e` block in `deploy/vps-sync-setup.sh` must stay identical — same salt (`cashfra-sync-v1`), same 200,000 rounds, same SHA-256. If they ever drift, ALFA is locked out of his own book with both sides looking correct; `test/code-login.mjs` compares them for exactly that reason.
- **Changing the code moves the book.** `rekey()` renames the blob, authenticated by the old key. Never ship a code change that does not re-key: the next unlock would derive a key the server has never seen, and the whole ledger would look gone.
- **Guessing must stay limited.** The key comes from six digits, so the server's per-address cap is the only thing between a stranger and the book. Do not remove it, and do not let a failed key go uncounted.
- **One address does everything**: `GET`/`PUT` on the sync URL for the ledger, `POST` on the same URL with `{action:'auth.start'|'auth.verify'}` to sign in. Do not move signing in to a sub-path — it was there once, and on a server whose nginx matched `/sync` exactly it never routed, answering 405 to the POST. The sub-paths still work where a prefix is routed; nothing may depend on them.
- The server still carries an email-and-code sign-in. Nothing in the app uses it and it is off unless `ALLOW` names an address. It was built, tested, then made unnecessary when ALFA asked for the code to be the login; leave it or delete it, but do not wire the app back to it without a reason.
- Every device holds the **same** key, so there is no per-device revoke: change the access code and the others need the new one. Whatever moves a book to a new key must **rename the blob with it** — a revoke that leaves the ledger behind under the old key is a lost book.
- Sync is **off unless switched on**, and single-device is still the supported default. When it is on it talks to ALFA's own VPS (`deploy/sync-server.js`, ~90 lines, one opaque JSON blob per token) and nowhere else. There are still no accounts: a token names a file that must already exist, and the service never creates one.
- A refused write (409) **merges and retries once, inside the same exchange**. Do not "simplify" that into an error message: the next automatic attempt only comes after the next edit, so a device that gives up sits on its entry, out of step, with nothing on screen to say so.
- The merge is a **union by entry id**, later `mt` winning a clash. It therefore **never deletes**: a deletion only reaches the other device while that device is online. This is the deliberate trade — losing an edit is recoverable, losing an entry is not.
- The access code is stripped from everything sent (`lockHash`, `lockSalt`, and the `sync` block itself). Each device keeps its own code, so a synced device is not an unlocked one.
- `sw.js` must keep skipping any request carrying `X-Cashfra-Token`. Cache the sync exchange and the app reads a stale version number, every write after it is refused, and even a `401` replays as a `200`.

## Deploy checklist

- [ ] HTTPS subdomain, not indexed (add `X-Robots-Tag: noindex` or robots.txt)
- [ ] Real manifest.json + icons extracted from the inline data URIs
- [ ] Service worker: cache-first on the app shell; bump cache name on every deploy
- [ ] Test on Android Chrome: install prompt, fullscreen, offline reload, data persists
- [ ] Confirm PIN 162007 opens it, then have ALFA change the code in Settings
