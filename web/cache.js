// Kaynak dosyalari icin 24 saatlik tarayici onbellegi.
// Ayni alani tekrar hesaplarken indirme yapilmaz; koyda cekim varken hesaplayip
// acikta ayni veriyle calismaya devam etmeyi de mumkun kilar.

const CACHE_NAME = 'denizrota-sources-v1';
const ORIGIN = 'https://denizrota.local/source/';
const MAX_ENTRIES = 12;

export class SourceCache {
  constructor(name = CACHE_NAME) { this.name = name; }

  async open() {
    if (typeof caches === 'undefined') return null;
    try { return await caches.open(this.name); } catch { return null; }
  }

  async get(key) {
    const cache = await this.open();
    if (!cache) return null;
    try {
      const response = await cache.match(ORIGIN + key);
      if (!response) return null;
      const downloadedAt = Number(response.headers.get('x-downloaded-at'));
      if (!Number.isFinite(downloadedAt)) return null;
      return { bytes: new Uint8Array(await response.arrayBuffer()), downloadedAt };
    } catch { return null; }
  }

  async put(key, bytes, downloadedAt) {
    const cache = await this.open();
    if (!cache) return;
    try {
      await cache.put(ORIGIN + key, new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-downloaded-at': String(downloadedAt),
        },
      }));
      await this.trim(cache);
    } catch { /* onbellek dolu olabilir; hesap yine de calisir */ }
  }

  async trim(cache) {
    const keys = await cache.keys();
    if (keys.length <= MAX_ENTRIES) return;
    const dated = [];
    for (const request of keys) {
      const response = await cache.match(request);
      dated.push({ request, at: Number(response?.headers.get('x-downloaded-at')) || 0 });
    }
    dated.sort((a, b) => b.at - a.at);
    for (const entry of dated.slice(MAX_ENTRIES)) await cache.delete(entry.request);
  }

  async clear() {
    if (typeof caches === 'undefined') return;
    try { await caches.delete(this.name); } catch { /* yoksay */ }
  }

  async size() {
    const cache = await this.open();
    if (!cache) return { entries: 0, bytes: 0 };
    const keys = await cache.keys();
    let bytes = 0;
    for (const request of keys) {
      const response = await cache.match(request);
      bytes += Number(response?.headers.get('content-length')) || 0;
    }
    return { entries: keys.length, bytes };
  }
}
