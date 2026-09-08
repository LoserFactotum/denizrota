// Open data sources. Same requests as ios/DenizRota/MarineDataService.swift, so
// a result computed here is reproducible from the recorded URL and query.
//
// EMODnet Bathymetry WCS   — numeric GeoTIFF, GEBCO infill included in the model.
// OSM Overpass             — coastline, rocks, wrecks, obstructions, reefs, piers.
// Both send Access-Control-Allow-Origin: *, so the browser calls them directly.

import { downloadBBox, overpassBBox, PlanningError } from './grid.js';

export const BATHYMETRY_ENDPOINT = 'https://ows.emodnet-bathymetry.eu/wcs';
// Overpass sunuculari sirayla denenir. Tek sunucu yogunlukta 429 dondurdugunde
// rota hesabi tamamen durmasin diye; hepsi ayni OSM verisini sunar ve hepsi
// CORS'a acik. Sira, ana sunucudan aynalara dogrudur.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
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

export function overpassQuery(bounds) {
  const b = overpassBBox(bounds);
  return `[out:json][timeout:90];(
way["natural"="coastline"](${b});
nwr["seamark:type"~"^(rock|wreck|obstruction|restricted_area|military_area|marine_farm)$"](${b});
nwr["man_made"~"^(pier|breakwater|groyne)$"](${b});
nwr["natural"="reef"](${b});
);out body geom;`;
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
export async function fetchSource({ url, body, cache, signal, label, cacheId }) {
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
  if (cache && cacheable) await cache.put(key, bytes, downloadedAt);
  return { bytes, downloadedAt, fromCache: false };
}

export async function fetchBathymetry(bounds, { cache, signal } = {}) {
  const url = bathymetryURL(bounds);
  const result = await fetchSource({ url, cache, signal, label: 'EMODnet derinlik servisi' });
  return { ...result, url };
}

export async function fetchOSM(bounds, { cache, signal, onProgress } = {}) {
  const query = overpassQuery(bounds);
  const body = new URLSearchParams({ data: query }).toString();
  let last = null;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = OVERPASS_ENDPOINTS[i];
    const host = new URL(url).host;
    try {
      const result = await fetchSource({
        url, body, cache, signal,
        cacheId: 'overpass',
        label: `OpenStreetMap Overpass (${host})`,
      });
      return { ...result, query, endpoint: url };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      last = error;
      // Yalnizca sunucu mesgul/erisilemez oldugunda aynaya gec. Sorgu hatasi
      // her sunucuda ayni sonucu verecegi icin tekrar denemek anlamsizdir.
      const retryable = error?.busy || error?.detail?.cause;
      if (!retryable || i === OVERPASS_ENDPOINTS.length - 1) throw error;
      onProgress?.(`${host} yogun, yedek sunucu deneniyor…`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  throw last;
}
