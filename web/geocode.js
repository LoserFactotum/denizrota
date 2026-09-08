// Yer arama ve koordinat cozumleme.
//
// Ucretsiz ve anahtarsiz kaynaklar: OpenStreetMap Nominatim ve Photon. Ikisi de
// Turkce koy/burun/ada adlarini biliyor. Google Maps'ten gelen baglantilar ve
// panodan yapistirilan koordinatlar da dogrudan cozumlenir; boylece Google'da
// bulunan bir yeri buraya tasimak icin API anahtari gerekmez.
//
// Ileride bir Google Places anahtari girilirse ayni arayuze ek kaynak olarak
// baglanabilir; anahtar yalnizca tarayicida saklanir, hicbir yere gonderilmez.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';

const KIND_LABELS = {
  bay: 'koy', strait: 'bogaz', cape: 'burun', island: 'ada', islet: 'adacik',
  village: 'koy', town: 'kasaba', city: 'sehir', hamlet: 'mahalle',
  harbour: 'liman', marina: 'marina', beach: 'plaj', peak: 'tepe',
  water: 'su', reef: 'resif', suburb: 'semt', locality: 'mevki',
  lighthouse: 'fener', pier: 'iskele', breakwater: 'mendirek', anchorage: 'demir yeri',
};

function normaliseNumber(text) {
  return Number(String(text).trim().replace(',', '.'));
}

/** "36 40.5 N" / "36°40'27\"" / "36.674" -> ondalik derece. */
function parseAngle(text, negativeLetters) {
  const cleaned = String(text).trim().toUpperCase().replace(/\s+/g, ' ');
  const letter = cleaned.match(/[NSEWKGDB]/)?.[0];
  const numbers = cleaned.replace(/[^\d.,\-+ ]/g, ' ').trim().split(/[ ]+/)
    .filter(Boolean).map(normaliseNumber);
  if (!numbers.length || numbers.some(n => !Number.isFinite(n))) return null;
  const sign = numbers[0] < 0 ? -1 : 1;
  let value = Math.abs(numbers[0]);
  if (numbers.length > 1) value += Math.abs(numbers[1]) / 60;
  if (numbers.length > 2) value += Math.abs(numbers[2]) / 3600;
  if (numbers.length > 3) return null;
  const negative = letter && negativeLetters.includes(letter);
  return sign * value * (negative ? -1 : 1);
}

/**
 * Serbest metinden koordinat cikarir. Desteklenen bicimler:
 *   36.674, 27.504            36,674 27,504
 *   36 40.5 N 27 30.2 E       36°40'27"N 27°30'13"E
 *   https://www.google.com/maps/@36.674,27.504,15z
 *   https://maps.google.com/?q=36.674,27.504     ...&ll=36.674,27.504
 *   https://www.google.com/maps/place/.../@36.674,27.504,17z/...
 */
export function parseCoordinates(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text) || text.includes('google.') || text.includes('goo.gl')) {
    if (/goo\.gl|maps\.app\.goo\.gl/i.test(text) && !/[@?]/.test(text.split('goo.gl')[1] ?? '')) {
      return { shortLink: true };
    }
    const patterns = [
      /[?&](?:ll|q|daddr|saddr|center)=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i,
      /[?&](?:ll|q|daddr|saddr|center)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
      /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
      /\/(-?\d+\.\d+),(-?\d+\.\d+)/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const latitude = Number(match[1]), longitude = Number(match[2]);
        if (isValid(latitude, longitude)) return { latitude, longitude, source: 'Google Maps baglantisi' };
      }
    }
    return null;
  }

  // Iki bilesene ayir: noktali virgul, "N.../E...", ya da bosluk/virgul.
  let parts = null;
  const letterSplit = text.match(/^\s*([\d.,'"°\s+-]*[NSKG][\d.,'"°\s+-]*)[,;\s]+([\d.,'"°\s+-]*[EWDB][\d.,'"°\s+-]*)\s*$/i)
    ?? text.match(/^\s*([NSKG][\d.,'"°\s+-]+)[,;\s]+([EWDB][\d.,'"°\s+-]+)\s*$/i);
  if (letterSplit) parts = [letterSplit[1], letterSplit[2]];
  else if (text.includes(';')) parts = text.split(';');
  else {
    const decimalPair = text.match(/^\s*(-?\d+[.,]?\d*)\s*[,\s]\s*(-?\d+[.,]?\d*)\s*$/);
    if (decimalPair) parts = [decimalPair[1], decimalPair[2]];
    else {
      const chunks = text.split(/\s{2,}|,\s+(?=[\d+-])/).filter(Boolean);
      if (chunks.length === 2) parts = chunks;
      else {
        const words = text.split(/\s+/);
        if (words.length === 6) parts = [words.slice(0, 3).join(' '), words.slice(3).join(' ')];
        else if (words.length === 4) parts = [words.slice(0, 2).join(' '), words.slice(2).join(' ')];
      }
    }
  }
  if (!parts || parts.length !== 2) return null;
  const latitude = parseAngle(parts[0], 'SG');   // South / Guney
  const longitude = parseAngle(parts[1], 'WB');  // West / Bati
  if (latitude === null || longitude === null || !isValid(latitude, longitude)) return null;
  return { latitude, longitude, source: 'Koordinat' };
}

function isValid(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    && !(latitude === 0 && longitude === 0);
}

function label(kind) { return KIND_LABELS[kind] ?? kind ?? ''; }

// Sokak, bina, durak gibi sonuclar denizde ise yaramaz; listeyi kirletmesinler.
const DROP_CATEGORIES = new Set([
  'highway', 'building', 'railway', 'barrier', 'power', 'office', 'craft',
  'healthcare', 'emergency', 'boundary',
]);
const DROP_TYPES = new Set([
  'residential', 'living_street', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway',
  'service', 'track', 'path', 'footway', 'unclassified', 'pedestrian', 'steps',
  'bus_stop', 'house', 'yes', 'apartments', 'construction',
]);

function useful(category, type) {
  if (DROP_CATEGORIES.has(category)) return false;
  if (DROP_TYPES.has(type)) return false;
  return true;
}

async function searchNominatim(query, { latitude, longitude, signal }) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '8', 'accept-language': 'tr', addressdetails: '1',
  });
  if (Number.isFinite(latitude)) {
    params.set('viewbox', [longitude - 1.5, latitude + 1.0, longitude + 1.5, latitude - 1.0].join(','));
  }
  const response = await fetch(`${NOMINATIM}?${params}`, { signal });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const rows = await response.json();
  return rows
    .filter(row => useful(row.category, row.type))
    .map(row => ({
      id: `n${row.osm_type ?? ''}${row.osm_id ?? row.place_id}`,
      name: row.name || String(row.display_name).split(',')[0],
      detail: String(row.display_name).split(',').slice(1, 4).join(',').trim(),
      kind: label(row.type),
      latitude: Number(row.lat),
      longitude: Number(row.lon),
      source: 'OpenStreetMap',
    })).filter(r => isValid(r.latitude, r.longitude));
}

async function searchPhoton(query, { latitude, longitude, signal }) {
  const params = new URLSearchParams({ q: query, limit: '8', lang: 'en' });
  if (Number.isFinite(latitude)) { params.set('lat', String(latitude)); params.set('lon', String(longitude)); }
  const response = await fetch(`${PHOTON}?${params}`, { signal });
  if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
  const data = await response.json();
  return (data.features ?? []).filter(feature => {
    const p = feature.properties ?? {};
    return useful(p.osm_key, p.osm_value);
  }).map(feature => {
    const p = feature.properties ?? {};
    return {
      id: `p${p.osm_type ?? ''}${p.osm_id ?? Math.random()}`,
      name: p.name ?? '',
      detail: [p.district, p.city, p.county, p.state, p.country].filter(Boolean).slice(0, 3).join(', '),
      kind: label(p.osm_value),
      latitude: feature.geometry?.coordinates?.[1],
      longitude: feature.geometry?.coordinates?.[0],
      source: 'Photon / OSM',
    };
  }).filter(r => r.name && isValid(r.latitude, r.longitude));
}

const KEY = (r) => `${r.name.toLocaleLowerCase('tr')}|${r.latitude.toFixed(3)}|${r.longitude.toFixed(3)}`;

/** Turkce harfleri sadelestirir: "Palamutbuku" ile "Palamutbükü" eslesir. */
function fold(text) {
  return String(text ?? '').toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ü/g, 'u').replace(/ö/g, 'o')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Once ad eslesmesinin kalitesi, sonra haritanin merkezine yakinlik. */
function nameScore(name, query) {
  const a = fold(name), b = fold(query);
  if (!b) return 4;
  if (a === b) return 0;
  if (a.startsWith(b)) return 1;
  if (a.includes(b)) return 2;
  if (b.includes(a)) return 3;
  return 4;
}

/**
 * Iki kaynagi birlikte sorgular, tekrarlari birlestirir ve haritanin
 * merkezine yakinlik ile siralar. Bir kaynak duserse digeri yine calisir.
 */
export async function searchPlaces(query, { latitude, longitude, signal } = {}) {
  const trimmed = String(query ?? '').trim();
  if (trimmed.length < 2) return [];
  const coordinate = parseCoordinates(trimmed);
  const direct = coordinate && !coordinate.shortLink ? [{
    id: 'coordinate',
    name: `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`,
    detail: coordinate.source,
    kind: 'koordinat',
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    source: coordinate.source,
    exact: true,
  }] : [];

  const settled = await Promise.allSettled([
    searchNominatim(trimmed, { latitude, longitude, signal }),
    searchPhoton(trimmed, { latitude, longitude, signal }),
  ]);
  const seen = new Set(direct.map(KEY));
  const merged = [...direct];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const row of result.value) {
      const key = KEY(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  const distance = (row) => Number.isFinite(latitude)
    ? Math.hypot(row.latitude - latitude, (row.longitude - longitude) * 0.8) : 0;
  merged.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const score = nameScore(a.name, trimmed) - nameScore(b.name, trimmed);
    if (score !== 0) return score;
    return distance(a) - distance(b);
  });
  return merged.slice(0, 10);
}

/** Haritada secilen nokta icin en yakin yer adi (ters arama). */
export async function reverseName(latitude, longitude, { signal } = {}) {
  const params = new URLSearchParams({
    lat: String(latitude), lon: String(longitude), format: 'jsonv2',
    zoom: '14', 'accept-language': 'tr',
  });
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, { signal });
    if (!response.ok) return null;
    const row = await response.json();
    return row?.name || String(row?.display_name ?? '').split(',')[0] || null;
  } catch { return null; }
}
