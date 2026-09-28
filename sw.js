/* Minimal service worker: it exists so the page meets the PWA
   "installable" criteria, which require a fetch handler. The handler
   stays empty — the jam needs the backend anyway, so there is nothing
   to cache and requests fall through to the network untouched. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
