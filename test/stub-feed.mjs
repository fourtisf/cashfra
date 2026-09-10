/* Stub the price feeds for the browser tests.
 *
 * There are two now: CoinGecko answers for every coin at once, and Coinbase
 * is the standby the app falls back to for whatever CoinGecko could not
 * answer. Both are stubbed here, and Coinbase is *unreachable* by default —
 * a suite that does not care about the failover then behaves exactly as it
 * did when there was one feed, and no suite ever touches the real internet.
 *
 * Deliberately an init script that swaps window.fetch, NOT Playwright's
 * context.route(): turning on request interception makes page fetches fail
 * while the service worker is still taking control, which shows up as
 * phantom failures that have nothing to do with the app.
 *
 * Call before the page navigates. Read the call count with feedHits(page).
 */
export const PRICES = {
  solana: { usd: 190, idr: 3097000 },
  binancecoin: { usd: 850, idr: 1.385e7 },
  ethereum: { usd: 3000, idr: 4.89e7 },
  tron: { usd: 0.28, idr: 4564 },
  tether: { usd: 1, idr: 16300 },
  'usd-coin': { usd: 1, idr: 16300 }
};

export async function stubFeed(ctx, prices = PRICES) {
  await ctx.addInitScript(raw => {
    const table = JSON.parse(raw);
    /* the flags ride in sessionStorage so they survive a reload */
    let down = false, hang = false, cb = null;
    try {
      down = sessionStorage.getItem('cashfra-feed-fail') === '1';
      hang = sessionStorage.getItem('cashfra-feed-hang') === '1';
      cb = JSON.parse(sessionStorage.getItem('cashfra-feed-cb') || 'null');
    } catch (e) {}
    window.__feed = { hits: 0, urls: [], fail: down, hang, cb, cbHits: 0, cbUrls: [] };
    const json = o => Promise.resolve(new Response(JSON.stringify(o), {
      status: 200, headers: { 'Content-Type': 'application/json' } }));
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');

      if (url.indexOf('api.coingecko.com') >= 0) {
        window.__feed.hits++;
        window.__feed.urls.push(url);
        /* a request that never settles — the app must survive it */
        if (window.__feed.hang) return new Promise(() => {});
        if (window.__feed.fail) return Promise.reject(new TypeError('feed down (stub)'));
        /* only the ids that were asked for, so a partial answer can be staged
           by leaving one out of the price table */
        const want = (/[?&]ids=([^&]*)/.exec(url) || [, ''])[1].split(',');
        const out = {};
        want.forEach(id => { if (table[id]) out[id] = table[id]; });
        return json(out);
      }

      if (url.indexOf('api.coinbase.com') >= 0) {
        window.__feed.cbHits++;
        window.__feed.cbUrls.push(url);
        const cbp = window.__feed.cb;
        if (!cbp) return Promise.reject(new TypeError('standby feed unreachable (stub)'));
        const spot = /\/v2\/prices\/([A-Za-z0-9]+)-USD\/spot/.exec(url);
        if (spot) {
          const v = cbp[spot[1].toUpperCase()];
          return v === undefined
            ? Promise.resolve(new Response('{"errors":[{"id":"not_found"}]}', { status: 404 }))
            : json({ data: { base: spot[1], currency: 'USD', amount: String(v) } });
        }
        if (url.indexOf('exchange-rates') >= 0) {
          return cbp.IDR === undefined
            ? Promise.reject(new TypeError('no rates (stub)'))
            : json({ data: { currency: 'USD', rates: { IDR: String(cbp.IDR) } } });
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }

      return real.call(this, input, init);
    };
  }, JSON.stringify(prices));
}

const flag = (page, key, val) => page.evaluate(([k, v]) => {
  window.__feed[k] = v;
  try { sessionStorage.setItem('cashfra-feed-' + k, v ? '1' : '0'); } catch (e) {}
}, [key, val]);

export const feedHits = page => page.evaluate(() => (window.__feed || { hits: 0 }).hits);
export const feedUrls = page => page.evaluate(() => (window.__feed || { urls: [] }).urls);
/* make the stub reject, so the app takes its offline / feed-down path */
export const feedDown = (page, down = true) => flag(page, 'fail', down);
/* make the stub never answer at all — the request that used to freeze prices
   for the life of the page */
export const feedHang = (page, hang = true) => flag(page, 'hang', hang);

/* Bring the standby feed up (or take it away with null). Keys are coin
   symbols plus an optional IDR for the USD→IDR rate. */
export const standby = (page, prices) => page.evaluate(p => {
  window.__feed.cb = p;
  try { sessionStorage.setItem('cashfra-feed-cb', JSON.stringify(p)); } catch (e) {}
}, prices);
export const standbyHits = page => page.evaluate(() => (window.__feed || { cbHits: 0 }).cbHits);
export const standbyUrls = page => page.evaluate(() => (window.__feed || { cbUrls: [] }).cbUrls);
