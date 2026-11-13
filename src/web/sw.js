// Service worker for the web version. tools/build-web.js stamps this file with
// a build id and the list of shell files to precache, so an installed Burst
// Super-Res opens and merges offline. User photos are never touched by this
// file: they live in the page's memory only.
'use strict';

const BUILD = '__BUILD__';
const SHELL_CACHE = 'burst-sr-shell-' + BUILD;
const RUN_CACHE = 'burst-sr-run-' + BUILD;

// tools/build-web.js replaces this list with every file the page needs.
const SHELL = /*__SHELL__*/ ['./', './index.html', './manifest.webmanifest'] /*__SHELL__*/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // allSettled: one missing file (a stale CI race) must not block the rest.
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL_CACHE && k !== RUN_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // analytics and links go straight to the network

  if (req.mode === 'navigate') {
    // Network first so a fresh visit gets the new build; the cached shell is
    // the offline path.
    e.respondWith(
      fetch(req).catch(async () => (await caches.match('./index.html')) || Response.error())
    );
    return;
  }
  // Network first, cache as the offline path. Cache-first would risk pairing a
  // new index.html with an old app.js during a deploy. The files are small;
  // the heavy work (pixels) never touches the network anyway.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(RUN_CACHE).then((c) => c.put(req, copy)).catch(() => { /* over quota: fine */ });
      }
      return res;
    }).catch(async () => (await caches.match(req)) || Response.error())
  );
});
