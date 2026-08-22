/**
 * The app shell, kept as an offline copy rather than as the thing normally
 * served: the daemon this talks to is local, so it is reachable in every case
 * except not running, and asking it first is what keeps an installed app from
 * launching into a build that has since been replaced.
 *
 * `/api/*` (including the SSE stream) is left alone entirely — caching or
 * intercepting it would break live updates and serve stale messages.
 */

/* The daemon rewrites this as it serves the file, to a digest of every asset
   under the web root — so any change to the UI is a change to this worker, and
   a browser installing it rebuilds the offline copy below in one pass and
   drops the old one. That matters most where the network-first fetch handler
   cannot help: an installed app that is resumed rather than relaunched never
   re-fetches the shell, and stays on whatever build it last installed until
   the worker itself is replaced.

   Served without a daemon in front of it, the placeholder stands and the
   worker still works — it just stops noticing new builds on its own. */
const BUILD = '__BUILD__';
const CACHE = `slick-shell-${BUILD}`;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/api.js',
  './js/format.js',
  './js/ui.js',
  './js/mentions.js',
  './js/panes.js',
  './js/push.js',
  './js/vendor/markdown-it.esm.min.mjs',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/**
 * Worth keeping? Only a plain same-origin answer from the daemon is.
 *
 * Behind an authenticating proxy — Cloudflare Access, say — an expired session
 * answers a request for `app.js` with a redirect to a login page, which then
 * comes back 200 OK and would otherwise be filed away *as* `app.js`. Once that
 * is in the cache the app is broken offline for good, and the sign-in it is
 * offering cannot be completed from inside a fetch handler anyway.
 */
function worthCaching(response) {
  return response.ok && !response.redirected && response.type === 'basic';
}

/**
 * Build the offline copy, refusing anything that is not the app.
 *
 * `cache.addAll` would take a proxy's sign-in page for a stylesheet — it only
 * asks whether the response was an error. Throwing instead is what keeps a
 * half-built shell from being installed: the worker never activates, and the
 * one already serving carries on.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    SHELL.map(async (path) => {
      // `reload` because this is the moment a new build is meant to arrive;
      // an HTTP cache hit here would install the previous one under a new name.
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!worthCaching(response)) throw new Error(`refusing to cache ${path}`);
      await cache.put(path, response);
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Slick', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Slick', {
      body: data.body ?? '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.tag,
      // channel/thread route an already-open window; url is the cold-start path.
      data: { url: data.url ?? './', channel: data.channel ?? null, thread: data.thread ?? null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const url = data.url ?? './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.startsWith(self.registration.scope));
      // Focusing alone used to be the whole handler, which is why tapping a
      // notification left you wherever you already were. Navigating an open
      // window by URL would throw its state away, so hand the target to the
      // app instead and let it route in place.
      if (existing) {
        existing.postMessage({ type: 'navigate', channel: data.channel, thread: data.thread });
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

/** However it was reached, the shell is one document — see `key` below. */
const SHELL_KEY = new URL('./index.html', self.location.href).href;

/** Fetch, and file a good response under the key it should be found by later. */
async function refresh(request, key) {
  const response = await fetch(request);
  if (worthCaching(response)) {
    const cache = await caches.open(CACHE);
    await cache.put(key, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  const navigating = event.request.mode === 'navigate';
  // Cache entries are keyed by full URL, so the `?token=…` the page is first
  // opened with would otherwise fork the shell into a second copy that nothing
  // ever precaches or evicts.
  const key = navigating ? SHELL_KEY : event.request;

  const network = refresh(event.request, key).catch(() => null);
  // Claimed here, synchronously, rather than left to run behind whichever
  // response we hand back: a revalidation the worker is not held open for gets
  // cut short by shutdown, which is how an installed app stays on an old shell
  // for good.
  event.waitUntil(network);

  event.respondWith(
    (async () => {
      // Network-first across the whole shell, document and assets alike. Doing
      // it for only some of them is worse than doing it for none: a fresh
      // index.html beside last week's stylesheet comes up visibly broken, and
      // the two can only stay in step if neither is allowed to lag. The cache
      // is what is left when the daemon is not running, which — being local —
      // is the only real reason to miss.
      const fresh = await network;
      // A redirect to a proxy's login page is a worse answer than a stale but
      // working shell — for a navigation, which the browser will follow, it is
      // the right one, but not for the modules the page is built out of.
      if (fresh && (navigating || worthCaching(fresh))) return fresh;
      return (await caches.match(key)) ?? fresh ?? Response.error();
    })()
  );
});
