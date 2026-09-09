// Kaynak dosyalari icin 24 saatlik tarayici onbellegi.
// Ayni alani tekrar hesaplarken indirme yapilmaz; koyda cekim varken hesaplayip
// acikta ayni veriyle calismaya devam etmeyi de mumkun kilar.

const CACHE_NAME = 'denizrota-sources-v1';
const ORIGIN = 'https://denizrota.local/source/';
const MAX_ENTRIES = 12;
const CACHE_SECONDS = 86400;

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

  async put(key, bytes, downloadedAt, meta) {
    const cache = await this.open();
    if (!cache) return;
    try {
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-downloaded-at': String(downloadedAt),
      };
      // Uzamsal meta: daha sonra bu kutuyu KAPSAYAN bir istek geldiginde
      // yeniden indirmek yerine bu girdi kullanilabilsin.
      if (meta?.family) headers['x-family'] = meta.family;
      if (meta?.bbox) headers['x-bbox'] = meta.bbox;
      await cache.put(ORIGIN + key, new Response(bytes, { headers }));
      await this.trim(cache);
    } catch { /* onbellek dolu olabilir; hesap yine de calisir */ }
  }

  /**
   * Ayni aileden, taze ve istenen kutuyu TAMAMEN KAPSAYAN bir girdi bul.
   * Birden fazlasi varsa en kucuk olani secilir: gereksiz yere devasa bir
   * yaniti islemeyelim.
   */
  async findContaining(family, bbox) {
    const cache = await this.open();
    if (!cache) return null;
    try {
      const keys = await cache.keys();
      let best = null;
      for (const request of keys) {
        const response = await cache.match(request);
        if (!response || response.headers.get('x-family') !== family) continue;
        const at = Number(response.headers.get('x-downloaded-at'));
        if (!Number.isFinite(at) || Date.now() - at < 0 || Date.now() - at >= CACHE_SECONDS * 1000) continue;
        const stored = String(response.headers.get('x-bbox') ?? '').split(',').map(Number);
        if (stored.length !== 4 || !stored.every(Number.isFinite)) continue;
        if (!(stored[0] <= bbox[0] && stored[1] <= bbox[1] && stored[2] >= bbox[2] && stored[3] >= bbox[3])) continue;
        const area = (stored[2] - stored[0]) * (stored[3] - stored[1]);
        if (!best || area < best.area) best = { area, response, at, bbox: stored };
      }
      if (!best) return null;
      return { bytes: new Uint8Array(await best.response.arrayBuffer()), downloadedAt: best.at, bbox: best.bbox };
    } catch { return null; }
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
