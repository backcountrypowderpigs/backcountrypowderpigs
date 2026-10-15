/* Offline support.
   - App shell: cached on install; network first so updates show at once, cached copy offline.
   - Map + elevation tiles: served from whichever area pack holds them; never cached on the fly,
     so storage only grows when you choose to download an area.
   - Bulletin: network first, last saved copy when offline. */
const SHELL = 'shell-v28';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'routes.js', 'share.js', 'sync.js', 'style.css', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/areas.json', 'data/known-slides.json', 'data/natural-onsens.json', 'data/bulletins.json'];

self.addEventListener('install', e => {
  // App files, plus every built-in area's place names so they work offline from the first install.
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).then(() =>
    fetch('data/areas.json').then(r => r.json()).then(j => Promise.all((j.areas || []).map(a => c.add('data/places/' + a.id + '.json').catch(() => { }))))
      .catch(() => { })
  )).then(() => self.skipWaiting()));
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
  // App files: newest version when there's signal (so updates show straight away), saved copy when not.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(r => {
      if (r.ok && !url.search) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
