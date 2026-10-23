// Service worker: keeps OnTilt usable without internet (needed for nearby/LAN play).
// Same-origin files: network first (always fresh when online), cache when offline.
// CDN modules and fonts: served from cache, refreshed in the background.
const VERSION = '__BUILD__';                 // replaced with the commit SHA at deploy
const CACHE = 'ontilt-' + VERSION;
// Every file in public/ must be listed here; CI checks this (tests/sw-files.test.mjs).
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'assets/favicon.svg', 'assets/apple-touch-icon.png', 'assets/og.png',
  'css/base.css', 'css/table.css', 'css/controls.css', 'css/lobby.css', 'css/overlays.css',
  'css/desktop.css', 'css/features.css', 'css/motion.css',
  'js/app.js', 'js/avatars.js', 'js/config.js', 'js/engine.js', 'js/lan.js', 'js/morph.js', 'js/qr.js', 'js/scan.js', 'js/sound.js', 'js/ui-helpers.js',
  'vendor/jsQR.min.js', 'vendor/qrcode.min.js',
];
const CDN = ['esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ontilt-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin === location.origin){
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try{
        // revalidate with the server (ETag) so all modules come from the same deploy
        const res = await Promise.race([fetch(req, { cache: 'no-cache' }), timeout(4000)]);
        if(res.ok) cache.put(req, res.clone());
        return res;
      }catch{
        return (await cache.match(req, { ignoreSearch: true })) ||
               (req.mode === 'navigate' ? await cache.match('index.html') : Response.error());
      }
    })());
  } else if(CDN.includes(url.hostname)){
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if(res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
