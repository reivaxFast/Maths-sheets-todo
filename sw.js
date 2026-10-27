// Service worker for the website: lets the installed app open offline and load instantly.
//
// The app's own files are served from the cache and refreshed in the background, so a new
// version appears on the next launch after it's published. Sync requests (Supabase) and
// anything else from other sites always go to the network.

const CACHE = 'worksheets-v1';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'script.js',
  'sync.js',
  'mobile.js',
  'web.js',
  'icon.png',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  const fresh = caches.open(CACHE).then(cache => fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }));
  // Keeps the worker alive until the background refresh has been saved
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(cached => cached || fresh));
});
