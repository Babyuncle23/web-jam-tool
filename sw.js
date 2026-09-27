/* Minimal service worker: it exists so the page meets the PWA
   "installable" criteria. Every request passes through to the network —
   the jam needs the backend anyway, so there is nothing to cache. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
