// Cevrimdisi kabuk. Uygulamanin kendisi cekim olmadan da acilir; hesaplanmis
// rota, noktalar ve GPS takibi calismaya devam eder.
//
// Harita dosecikleri yalnizca KULLANICI o alani gercekten goruntuledigi icin
// indirilmisse saklanir. Onceden toplu doseme indirilmez: bu, OpenStreetMap ve
// OpenSeaMap doseme kullanim kurallarina uymak icin bilincli bir sinirdir.

const SHELL = 'denizrota-shell-v1';
const TILES = 'denizrota-tiles-v1';
const TILE_LIMIT = 900;

const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './mapview.js', './geocode.js',
  './store.js', './gpx.js', './sun.js', './cache.js', './worker.js',
  './engine/planner.js', './engine/router.js', './engine/grid.js',
  './engine/geotiff.js', './engine/mask.js', './engine/navmath.js', './engine/sources.js',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './vendor/images/marker-icon.png', './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png', './vendor/images/layers.png', './vendor/images/layers-2x.png',
  './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map(file => cache.add(file)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('denizrota-shell-') && name !== SHELL) await caches.delete(name);
      if (name.startsWith('denizrota-tiles-') && name !== TILES) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  for (const request of keys.slice(0, keys.length - TILE_LIMIT)) await cache.delete(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Harita dosecikleri: once ag, basarisiz olursa daha once goruleni goster.
  if (/tile\.openstreetmap\.org|tiles\.openseamap\.org/.test(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      try {
        const response = await fetch(request);
        if (response.ok) { cache.put(request, response.clone()); trimTiles(); }
        return response;
      } catch (error) {
        const hit = await cache.match(request);
        if (hit) return hit;
        throw error;
      }
    })());
    return;
  }

  // Derinlik/engel servisleri ve arama: onbelleklenmez, hep guncel istenir.
  if (url.origin !== self.location.origin) return;

  // Uygulama dosyalari: once ag (guncel kalsin), yoksa kabuk onbellegi.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(request) ?? await cache.match('./index.html');
      if (hit) return hit;
      throw error;
    }
  })());
});
