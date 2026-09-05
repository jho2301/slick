/**
 * The app shell, kept as an offline copy rather than as the thing normally
 * served: the daemon this talks to is local, so it is reachable in every case
 * except not running, and asking it first is what keeps an installed app from
 * launching into a build that has since been replaced.
 *
 * `/api/*` (including the SSE stream) is left alone entirely — caching or
 * intercepting it would break live updates and serve stale messages.
 */

/// <reference lib="webworker" />

export {};

interface ManifestEntry {
  url: string;
  revision: string | null;
}

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: ManifestEntry[] };

/**
 * Every file the build produced, with a revision for each — written in here
 * by the bundler as it emits the worker. Any change to the UI is a change to
 * this list, and so to the worker's own bytes, and so a browser installing
 * it rebuilds the offline copy below in one pass and drops the old one. That
 * matters most where the network-first fetch handler cannot help: an
 * installed app that is resumed rather than relaunched never re-fetches the
 * shell, and stays on whatever build it last installed until the worker
 * itself is replaced.
 */
const MANIFEST: readonly ManifestEntry[] = self.__WB_MANIFEST;

/** A short name for this build, from what is in it. */
function stamp(entries: readonly ManifestEntry[]): string {
  // FNV-1a, because a worker's install step has no synchronous digest and the
  // name only has to differ between two builds, not resist anybody.
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    for (const ch of `${entry.url}@${entry.revision ?? ''}\n`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

const BUILD = stamp(MANIFEST);
const CACHE = `slick-shell-${BUILD}`;

/** Every asset of the build, as the URL it is fetched by. Nothing is missed: the bundler wrote the list. */
const SHELL: readonly string[] = [
  './',
  ...MANIFEST.map((entry) => new URL(entry.url, self.location.href).href),
];

/**
 * Worth keeping? Only a plain same-origin answer from the daemon is.
 *
 * Behind an authenticating proxy — Cloudflare Access, say — an expired session
 * answers a request for a bundle with a redirect to a login page, which then
 * comes back 200 OK and would otherwise be filed away *as* the bundle. Once
 * that is in the cache the app is broken offline for good, and the sign-in it
 * is offering cannot be completed from inside a fetch handler anyway.
 */
function worthCaching(response: Response): boolean {
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
async function precache(): Promise<void> {
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
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  channel?: string | null;
  thread?: string | null;
}

/** What a push carried, read leniently: a notification with a wrong shape still shows. */
function readPush(event: PushEvent): PushPayload {
  if (!event.data) return {};
  try {
    const parsed: unknown = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { title: 'Slick', body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const data = readPush(event);
  event.waitUntil(
    self.registration.showNotification(data.title || 'Slick', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      // channel/thread route an already-open window; url is the cold-start path.
      data: { url: data.url ?? '/', channel: data.channel ?? null, thread: data.thread ?? null },
    })
  );
});

/** What a notification was told to open, as the tap handler reads it back. */
interface NotificationTarget {
  url?: string;
  channel?: string | null;
  thread?: string | null;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw: unknown = event.notification.data;
  const data: NotificationTarget = raw && typeof raw === 'object' ? raw : {};
  const url = data.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.startsWith(self.registration.scope));
      // Focusing alone used to be the whole handler, which is why tapping a
      // notification left you wherever you already were. Navigating an open
      // window by URL would throw its state away, so hand the target to the
      // app instead and let it route in place.
      if (existing) {
        existing.postMessage({
          type: 'navigate',
          channel: data.channel ?? null,
          thread: data.thread ?? null,
        });
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

/** However it was reached, the shell is one document — see `key` below. */
const SHELL_KEY = new URL('./index.html', self.location.href).href;

/** Fetch, and file a good response under the key it should be found by later. */
async function refresh(request: Request, key: Request | string): Promise<Response> {
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
