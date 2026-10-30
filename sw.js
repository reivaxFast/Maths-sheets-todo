// Service worker for the website: lets the installed app open offline and load instantly.
//
// The app's own files are served from the cache and refreshed in the background, so a new
// version appears on the next launch after it's published. Sync requests (Supabase) and
// anything else from other sites always go to the network.

// Changing the name clears the old cache, e.g. after updating a library in node_modules
const CACHE = 'worksheets-v3';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'script.js',
  'claude.js',
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
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Libraries (e.g. the 11 MB OpenCV used by the scanner) are kept once downloaded rather
  // than fetched again in the background on every launch
  if (url.pathname.includes('/node_modules/')) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }));
    return;
  }

  const fresh = caches.open(CACHE).then(cache => fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }));
  // Keeps the worker alive until the background refresh has been saved
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(cached => cached || fresh));
});
