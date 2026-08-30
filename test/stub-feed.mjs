/* Stub the CoinGecko price feed for the browser tests.
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
  await ctx.addInitScript(body => {
    /* the fail flag rides in sessionStorage so it survives a reload */
    let down = false;
    try { down = sessionStorage.getItem('cashfra-feed-fail') === '1'; } catch (e) {}
    window.__feed = { hits: 0, urls: [], fail: down };
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      if (url.indexOf('api.coingecko.com') >= 0) {
        window.__feed.hits++;
        window.__feed.urls.push(url);
        if (window.__feed.fail) return Promise.reject(new TypeError('feed down (stub)'));
        return Promise.resolve(new Response(body, {
          status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.call(this, input, init);
    };
  }, JSON.stringify(prices));
}

export const feedHits = page => page.evaluate(() => (window.__feed || { hits: 0 }).hits);
/* make the stub reject, so the app takes its offline / feed-down path */
export const feedDown = (page, down = true) => page.evaluate(v => {
  window.__feed.fail = v;
  try { sessionStorage.setItem('cashfra-feed-fail', v ? '1' : '0'); } catch (e) {}
}, down);
export const feedUrls = page => page.evaluate(() => (window.__feed || { urls: [] }).urls);
