/* Offline support.
   - App shell: cached on install, served cache-first.
   - Map + elevation tiles: served from whichever area pack holds them; never cached on the fly,
     so storage only grows when you choose to download an area.
   - Bulletin: network first, last saved copy when offline. */
const SHELL = 'shell-v3';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/areas.json', 'data/known-slides.json', 'data/bulletins.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    e.respondWith(caches.match(req.url).then(hit => hit || fetch(req).catch(() => new Response('', { status: 504 }))));
    return;
  }
  if (url.origin === location.origin && url.pathname.endsWith('/data/bulletins.json')) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(new URL('data/bulletins.json', self.registration.scope).href, copy)); }
      return r;
    }).catch(() => caches.match(new URL('data/bulletins.json', self.registration.scope).href)));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
  }
});
