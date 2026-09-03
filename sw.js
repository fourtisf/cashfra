/* Cashfra service worker — offline app shell.
 *
 * Cache-first so the app opens instantly and works with no connection.
 * BUILD is the cache name; bump it on every deploy (./bump-version.sh does it).
 * Nothing here touches app data — the ledger lives in localStorage, never in
 * the cache, so activating a new shell can never drop a single entry.
 */
var BUILD = '2026-09-03-3';
var CACHE = 'cashfra-' + BUILD;
var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* bypass the HTTP cache so a deploy is never precached stale */
    return Promise.all(SHELL.map(function (u) {
      return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
        if (!res || !res.ok) throw new Error('precache failed: ' + u);
        return c.put(u, res);
      });
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('cashfra-') === 0) return caches.delete(k);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

/* the page asks for the swap once it is hidden, so a live screen never blinks */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  /* the ledger sync is live data, not shell. Serving it from the cache would
     hand the app a stale version number, and every write after that would be
     refused as out of date — so it goes straight to the network. */
  if (req.headers.get('X-Cashfra-Token')) return;

  /* every navigation gets the cached shell, refreshed in the background */
  var key = (req.mode === 'navigate') ? './index.html' : req;

  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(key).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          c.put(key, copy);
          if (key === './index.html') c.put('./', res.clone());
        }
        return res;
      })['catch'](function () {
        /* offline: whatever we already hold, else an honest failure */
        return hit || new Response('', { status: 504, statusText: 'Offline' });
      });

      if (hit) { e.waitUntil(net); return hit; }
      return net;
    });
  }));
});
