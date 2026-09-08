// Cihazda kalan veriler: kayitli rotalar, tekne profili, ayarlar.
// Hicbir sunucuya gonderilmez. Okunamayan bir kayit sessizce silinmez.

const ROUTES_KEY = 'denizrota.routes.v1';
const BOAT_KEY = 'denizrota.boat.v1';
const SETTINGS_KEY = 'denizrota.settings.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function loadRoutes() {
  const rows = read(ROUTES_KEY, []);
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => r && typeof r.name === 'string' && Array.isArray(r.points) && r.points.length);
}

export function saveRoute(route) {
  const rows = loadRoutes();
  const index = rows.findIndex(r => r.id === route.id);
  const stored = {
    id: route.id,
    name: route.name,
    savedAt: route.savedAt,
    speedKnots: route.speedKnots,
    points: route.points,
    anchors: route.anchors ?? null,
    boat: route.boat ?? null,
    legs: route.legs ?? null,
    distanceM: route.distanceM ?? null,
    minimumDepth: route.minimumDepth ?? null,
    shallowestModelDepth: route.shallowestModelDepth ?? null,
    provenance: route.provenance ?? null,
  };
  if (index >= 0) rows[index] = stored; else rows.push(stored);
  return write(ROUTES_KEY, rows);
}

export function deleteRoute(id) {
  return write(ROUTES_KEY, loadRoutes().filter(r => r.id !== id));
}

export function loadBoat(fallback) {
  const boat = read(BOAT_KEY, null);
  if (!boat) return { ...fallback };
  const merged = { ...fallback };
  for (const key of Object.keys(fallback)) {
    if (Number.isFinite(boat[key])) merged[key] = boat[key];
  }
  return merged;
}

export function saveBoat(boat) { return write(BOAT_KEY, boat); }

export function loadSettings(fallback) {
  return { ...fallback, ...(read(SETTINGS_KEY, null) ?? {}) };
}

export function saveSettings(settings) { return write(SETTINGS_KEY, settings); }

const TRACK_KEY = 'denizrota.track.v1';

export function loadTrack() {
  const rows = read(TRACK_KEY, []);
  if (!Array.isArray(rows)) return [];
  return rows.filter(p => Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude) && Number.isFinite(p?.at));
}

export function saveTrack(track) { return write(TRACK_KEY, track); }

// --- paylasilabilir baglanti -------------------------------------------------
// Rota, adres cubugunda kodlanir: link atarsan karsi taraf ayni rotayi acar.

export function encodeRoute(route) {
  const compact = {
    n: route.name,
    s: route.speedKnots,
    b: route.boat ? [route.boat.draft, route.boat.underKeel, route.boat.modelAllowance,
      route.boat.waterLevelDrop, route.boat.horizontalBuffer] : null,
    a: (route.anchors ?? route.points).map(p => [
      Number(p.latitude.toFixed(6)), Number(p.longitude.toFixed(6)), p.name ?? '',
    ]),
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(compact))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeRoute(token) {
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const compact = JSON.parse(decodeURIComponent(escape(atob(base64))));
    if (!Array.isArray(compact.a) || compact.a.length < 2) return null;
    const anchors = compact.a.map(([latitude, longitude, name], i) => {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('gecersiz');
      return { name: name || `Nokta ${i + 1}`, latitude, longitude };
    });
    return {
      name: compact.n || 'Paylasilan rota',
      speedKnots: Number.isFinite(compact.s) ? compact.s : 5,
      boat: Array.isArray(compact.b) && compact.b.length === 5 ? {
        draft: compact.b[0], underKeel: compact.b[1], modelAllowance: compact.b[2],
        waterLevelDrop: compact.b[3], horizontalBuffer: compact.b[4],
      } : null,
      anchors,
    };
  } catch { return null; }
}
