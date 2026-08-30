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
2. **Received vs booked.** `recv(t)`: unpaid→0, dp→`paid`, paid→`usd`. Money-in totals (`gi`) use *received*. Receivables (`pi`) = Σ(usd − recv) on income.
3. **Commission is per-recipient.** In the form, **% is the source of truth** — USD is derived (`deal usd × pct/100`) and shown read-only. Typing a team member's name auto-fills their default %. Multiple recipients per deal are supported.
4. **Commission never double-counts** — the subtlest rule. Two ways to log a commission exist: (a) inside the income entry (`coms[]`, accrual) and (b) as a money-out entry with category **`Team commission`** (payout). Reconciliation is per person name, in `totals()` and `comBook()`:
   - `A` = accrued (Σ coms.usd on income), `M` = accruals marked paid, `P` = Σ Team-commission expenses to that name.
   - cost = `max(A, P)` · credit = `min(A, max(P, M))` · owed = `A − credit`.
   - **`Team commission` expenses are EXCLUDED from `go` (Money out)** — they settle the accrual, they are not a new cost. Verified invariant: paying out a tracked commission leaves net profit unchanged.
5. **Period engine.** `per='m'|'w'`; weeks start **Monday** (`weekStart`). `periodTx(offset)` drives everything visible (hero, deltas, streak, list, insights, recap). `monthOnlyTx()` is intentionally month-based regardless of view — used by the Team-bonus %-of-income quick calc and the monthly CSV export. Recurring reminders are also calendar-month based.
6. **Growth deltas.** vs previous period: % when previous > 0, absolute $ otherwise (avoids nonsense % across sign changes). For Money out and Commission chips the color logic is inverted (increase = red).
7. **Brand scoping.** Every query filters by `brandView` ('' = All). Entries carry `brand`; renaming a brand in Settings does **not** retag old entries (accepted limitation).
8. **Recurring** = one expected copy per calendar month, keyed `brand|cat|party`; banner offers one-tap logging with undo.
9. **Invoices are a view, never data.** `invHtml`/`invText` are derived from an entry every time — no invoice is stored, and the document number (`invNo`) is a pure function of brand + date + id, so the same deal always produces the same number. An entry with `status:'unpaid'` is a **Quotation**; anything else is an **Invoice**. Nothing about this writes to the Entry.
10. **Access code.** Preset **162007**, seeded once via marker `lockPreset='162007-v1'` (salt `'fs1'`, hash = SHA-256(`salt:code`), FNV-1a fallback where `crypto.subtle` is unavailable). PIN pad shows when `lockNum`; auto-submits at `lockLen` digits. Change/remove in Settings → App lock. "Forgot" = wipe everything + reseed 162007. This is **client-side deterrence, not security** — the owner knows; don't pretend otherwise, and don't remove it.

## Feature inventory (regression checklist)

PIN gate (setup/lock/change/forgot, auto-lock on leaving with a grace period) · brand switcher + inline "New brand" · M/W toggle with 12-bucket strip, ‹›/arrow-key nav, jump-to-period · animated net + growth pills + streak · delta lines on chips · notices (receivables filter, recurring one-tap log w/ undo) · entry form (brand chips, package chips, centered amount w/ "2.5 bnb" parsing, token pills, auto-rate, chain pills, Team-bonus % quick calc, multi-recipient commission with owed-hint "use this amount", announcement link with Open ↗, status/partial, recurring switch) · edit/delete+undo/duplicate/save-&-add-more · search + filters · Commission panel (netted book, per-person Mark-all-paid, per-recipient per-deal toggles, payouts list) · Insights (composition bars with a %-of-spend / %-of-money-in toggle, spending caps vs actual, **period-vs-period comparison** per category with 6-period sparklines, **brand vs brand** table, package & chain mix donuts with a this-period/all-time toggle, package profitability + margin, cost ratio vs prev, avg deal, run-rate) · Clients (net of commission, repeat rate, contacts) · recap ✨ stories · CSV month/all (20 cols incl. Brand, Announce link) · JSON backup/restore + overdue reminder + OS share · invoice/quotation sheet (copy text, print to PDF) · client contacts · monthly target card · demo seed + wipe w/ undo · keyboard: n, /, Enter, Esc, arrows.

If you refactor, walk this list on mobile viewport before shipping.

## Known limitations (by design — do not "fix" without asking ALFA)

- claude.ai storage and standalone localStorage are **separate stores**; migration is manual via Backup/Restore JSON.
- Run-rate is a linear projection; noisy early in a period.
- The monthly target is one global number, not per brand, and only shows in month view.
- Spending caps match on the exact category name; a typo silently never matches.
- The brand table deliberately ignores `brandView` — comparing brands is the whole point of it.
- Comparison rows bucket by category, and take commission from `totals().gc` so the netting rule in business rule 4 stays the single source of truth for it.
- Client contacts are keyed by the client's name: rename a client and the contact does not follow.
- Leaving the app always covers the screen (so the Android app-switcher snapshot is safe); `lockIdle` only decides whether the code is asked for again on return.
- Live prices come from CoinGecko's free endpoint, at most once every 30 min, and fail silently when offline — the last known prices stay. Only symbols in the `COINS` map are looked up; anything else stays manual.
- The mix donuts hand out six colour slots by an entity's position in `CATS.in` / `S.chains`, never by rank. Anything past the sixth folds into one grey "Other".
- IDR display rate follows the price feed while auto-update is on (it rides on `tether.idr`); switch auto off in Settings to pin it by hand.
- No server, no accounts, no sync — single-user by design. If ALFA later wants multi-device sync, propose a tiny backend then; do not add one now.

## Deploy checklist

- [ ] HTTPS subdomain, not indexed (add `X-Robots-Tag: noindex` or robots.txt)
- [ ] Real manifest.json + icons extracted from the inline data URIs
- [ ] Service worker: cache-first on the app shell; bump cache name on every deploy
- [ ] Test on Android Chrome: install prompt, fullscreen, offline reload, data persists
- [ ] Confirm PIN 162007 opens it, then have ALFA change the code in Settings
