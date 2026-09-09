// Open data sources. Same requests as ios/DenizRota/MarineDataService.swift, so
// a result computed here is reproducible from the recorded URL and query.
//
// EMODnet Bathymetry WCS   — numeric GeoTIFF, GEBCO infill included in the model.
// OSM Overpass             — coastline, rocks, wrecks, obstructions, reefs, piers.
// Both send Access-Control-Allow-Origin: *, so the browser calls them directly.

import { downloadBBox, overpassBBox, PlanningError } from './grid.js';

export const BATHYMETRY_ENDPOINT = 'https://ows.emodnet-bathymetry.eu/wcs';
// Overpass sunuculari sirayla denenir; hepsi ayni OSM verisini sunar ve hepsi
// CORS'a acik. Sira, ana sunucudan aynalara dogrudur.
//
// Overpass IP basina yalnizca birkac es zamanli slot verir. Slotlar dolunca
// dogru davranis BEKLEMEKTIR; sunuculari saniyeler icinde arka arkaya
// zorlamak durumu kotulestirir. Bu yuzden tur tur denenir ve turlar arasinda
// giderek artan sure beklenir.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const OVERPASS_RETRY_WAITS_MS = [0, 8000, 25000, 60000];

/** Iptal edilebilir bekleme. */
function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() {
      clearTimeout(timer);
      const error = new Error('Hesap iptal edildi.');
      error.name = 'AbortError';
      reject(error);
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
export const OVERPASS_ENDPOINT = OVERPASS_ENDPOINTS[0];
export const SOURCE_LABEL = 'EMODnet DTM · GEBCO dolgusu dahil';
export const MAX_RESPONSE_BYTES = 80000000;
export const CACHE_SECONDS = 86400;
export const USER_AGENT = 'DenizRota/0.3 (open-data marine route planner)';

// Overpass rejects requests with no identifiable User-Agent (HTTP 406). Browsers
// send their own and forbid overriding it — setting it there would only risk a
// needless CORS preflight — so this header is added on Node only.
const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

export function bathymetryURL(bounds) {
  const params = {
    bbox: downloadBBox(bounds),
    compression: 'NONE',
    coverage: 'emodnet:mean',
    crs: 'EPSG:4326',
    format: 'GeoTIFF',
    interpolation: 'nearest',
    request: 'GetCoverage',
    resx: String(1 / 960),
    resy: String(1 / 960),
    service: 'WCS',
    version: '1.0.0',
  };
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) search.append(key, params[key]);
  return `${BATHYMETRY_ENDPOINT}?${search}`;
}

export function overpassQueryForBBox(b) {
  return `[out:json][timeout:90];(
way["natural"="coastline"](${b});
nwr["seamark:type"~"^(rock|wreck|obstruction|restricted_area|military_area|marine_farm)$"](${b});
nwr["man_made"~"^(pier|breakwater|groyne)$"](${b});
nwr["natural"="reef"](${b});
);out body geom;`;
}

export function overpassQuery(bounds) {
  return overpassQueryForBBox(overpassBBox(bounds));
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(url, body) {
  const encoder = new TextEncoder();
  const urlBytes = encoder.encode(url);
  const bodyBytes = body ? encoder.encode(body) : new Uint8Array(0);
  const joined = new Uint8Array(urlBytes.length + bodyBytes.length);
  joined.set(urlBytes, 0);
  joined.set(bodyBytes, urlBytes.length);
  return sha256Hex(joined);
}

/**
 * Fetch with a 24 h cache. Network success alone does not certify content —
 * the caller always validates it. Obvious XML/HTML error pages and Overpass
 * "remark" responses are never cached as if they were data.
 */
export async function fetchSource({ url, body, cache, signal, label, cacheId, meta }) {
  // Onbellek kimligi istekten ayrilabilir: ayni Overpass sorgusu hangi aynadan
  // gelirse gelsin ayni veridir, tekrar indirilmemeli.
  const key = await cacheKey(cacheId ?? url, body);
  if (cache) {
    const hit = await cache.get(key);
    if (hit && Number.isFinite(hit.downloadedAt)
      && Date.now() - hit.downloadedAt >= 0 && Date.now() - hit.downloadedAt < CACHE_SECONDS * 1000) {
      return { bytes: hit.bytes, downloadedAt: hit.downloadedAt, fromCache: true };
    }
  }
  const headers = {};
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  if (IS_NODE) headers['User-Agent'] = USER_AGENT;
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new PlanningError(`${label} servisine ulasilamadi. Baglantiyi kontrol edip tekrar deneyin.`,
      { cause: String(error) });
  }
  if (!response.ok) {
    const busy = response.status === 429 || response.status === 504 || response.status === 503;
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Yaklasik ${retryAfter} saniye sonra tekrar deneyin.` : '';
    const error = new PlanningError(busy
      ? `${label} su an yogun (HTTP ${response.status}).${wait || ' Biraz sonra tekrar deneyin.'}`
      : `${label} yanit vermedi (HTTP ${response.status}). Tekrar deneyebilirsiniz.`,
      { status: response.status, busy });
    error.busy = busy;
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) {
    throw new PlanningError(`${label} yaniti bos veya indirme sinirini asiyor.`, { length: bytes.length });
  }
  const downloadedAt = Date.now();
  let cacheable = bytes[0] !== 0x3c; // never store an XML/HTML error page as data
  if (cacheable && bytes[0] === 0x7b) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && parsed.remark) cacheable = false;
    } catch { cacheable = false; }
  }
  if (cache && cacheable) await cache.put(key, bytes, downloadedAt, meta);
  return { bytes, downloadedAt, fromCache: false };
}

export async function fetchBathymetry(bounds, { cache, signal } = {}) {
  const url = bathymetryURL(bounds);
  const result = await fetchSource({ url, cache, signal, label: 'EMODnet derinlik servisi' });
  return { ...result, url };
}

/** "s,w,n,e" metnini sayilara cevirir. */
function parseBBox(text) {
  const parts = String(text).split(',').map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}

/** a kutusu b kutusunu tamamen kapsiyor mu? (s,w,n,e sirasi) */
function contains(a, b) {
  return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
}

export async function fetchOSM(bounds, { cache, signal, onProgress, retryWaitsMs = OVERPASS_RETRY_WAITS_MS } = {}) {
  const bboxText = overpassBBox(bounds);
  const bbox = parseBBox(bboxText);
  const query = overpassQueryForBBox(bboxText);
  const body = new URLSearchParams({ data: query }).toString();
  let last = null;

  // Daha once indirilmis DAHA GENIS bir kutu bu rotayi kapsiyorsa onu kullan.
  // Teknede zayif LTE'de ve Overpass'in IP basina slot limiti altinda en degerli
  // kazanc bu: ayni bolgede ikinci rota hic indirme yapmaz.
  //
  // Guvenli: grid disindaki nesneler hicbir hucreye dokunmaz, kiyi butunluk
  // kontrolu yalnizca grid icindeki dugumlere bakar, ve tarama cizgisinin
  // batisindaki fazladan kesisimler kara/deniz paritesini daha saglam kurar.
  if (cache?.findContaining && bbox) {
    const hit = await cache.findContaining('overpass', bbox);
    if (hit) {
      return {
        bytes: hit.bytes, downloadedAt: hit.downloadedAt, fromCache: true,
        query: overpassQueryForBBox(hit.bbox.join(',')),
        endpoint: 'onbellek', cachedBBox: hit.bbox.join(','),
      };
    }
  }

  for (let round = 0; round < retryWaitsMs.length; round++) {
    const wait = retryWaitsMs[round];
    if (wait > 0) {
      // Slotun bosalmasini beklerken kullaniciya ne kadar kaldigini soyle:
      // dugmeye tekrar basmak durumu kotulestirir.
      for (let left = Math.round(wait / 1000); left > 0; left--) {
        onProgress?.(`Overpass sunuculari yogun. ${left} sn sonra yeniden denenecek…`);
        await delay(1000, signal);
      }
    }
    for (const url of OVERPASS_ENDPOINTS) {
      const host = new URL(url).host;
      try {
        onProgress?.(round === 0
          ? `Kiyi, kayalik, batik ve engeller indiriliyor (${host})…`
          : `Yeniden deneniyor: ${host}…`);
        const result = await fetchSource({
          url, body, cache, signal,
          cacheId: 'overpass',
          meta: { family: 'overpass', bbox: bboxText },
          label: `OpenStreetMap Overpass (${host})`,
        });
        return { ...result, query, endpoint: url };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        last = error;
        // Yalnizca sunucu mesgul/erisilemez oldugunda devam et. Sorgu hatasi
        // her sunucuda ayni sonucu verecegi icin tekrar denemek anlamsizdir.
        const retryable = error?.busy || error?.detail?.cause;
        if (!retryable) throw error;
      }
    }
  }
  throw new PlanningError(
    'OpenStreetMap Overpass sunuculari su an yanit vermiyor. Birkac dakika sonra '
    + 'tekrar deneyin — ayni bolgede daha once hesaplanmis bir rota varsa o veri '
    + 'onbellekten kullanilabilir.',
    { busy: true, cause: last?.message });
}
