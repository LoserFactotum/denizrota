// Rota boyunca ruzgar ve dalga — Open-Meteo (ucretsiz, anahtarsiz, CORS acik).
//
// Her donus noktasi icin ORAYA VARILACAK SAATTEKI tahmin alinir: hava zamana
// baglidir, kalkis saati degisince degerler de degisir. Saf hesap fonksiyonlari
// (enterpolasyon, ruzgar acisi, etap degerlendirmesi) DOM'a dokunmaz; Node'da
// test edilir.
//
// Durust sinir: model gridi ~9 km. Burun hamleleri, ruzgar golgesi, ogleden
// sonra hizlanan meltem termigi cozulmez. Kiyidan acikta iyi, koy icinde kaba.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const CACHE_KEY = 'denizrota.weather.v1';
const CACHE_MS = 45 * 60 * 1000;
const MAX_FORECAST_DAYS = 7;

export const WIND_MODEL_NOTE = 'Open-Meteo best_match (ICON/GFS/ECMWF karisimi), ~9 km grid — kiyi etkilerini cozmez.';

// ------------------------------------------------------------- saf hesaplar

/** Saatlik dizide atMs anina dogrusal enterpolasyon; disinda kalirsa en yakin uc. */
export function interpolateLinear(timesSec, values, atMs) {
  const t = atMs / 1000;
  if (!timesSec?.length) return NaN;
  if (t <= timesSec[0]) return values[0];
  if (t >= timesSec[timesSec.length - 1]) return values[values.length - 1];
  let i = 1;
  while (i < timesSec.length && timesSec[i] < t) i++;
  const a = values[i - 1], b = values[i];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : b;
  const f = (t - timesSec[i - 1]) / (timesSec[i] - timesSec[i - 1]);
  return a + (b - a) * f;
}

/** Yon (derece) enterpolasyonu vektor uzerinden: 350° ile 10° arasi 0°, 180° degil. */
export function interpolateDirection(timesSec, degrees, atMs) {
  const t = atMs / 1000;
  if (!timesSec?.length) return NaN;
  const wrap = (d) => ((d % 360) + 360) % 360;
  if (t <= timesSec[0]) return wrap(degrees[0]);
  if (t >= timesSec[timesSec.length - 1]) return wrap(degrees[degrees.length - 1]);
  let i = 1;
  while (i < timesSec.length && timesSec[i] < t) i++;
  const a = degrees[i - 1], b = degrees[i];
  if (!Number.isFinite(a)) return wrap(b);
  if (!Number.isFinite(b)) return wrap(a);
  const f = (t - timesSec[i - 1]) / (timesSec[i] - timesSec[i - 1]);
  const ra = a * Math.PI / 180, rb = b * Math.PI / 180;
  const x = Math.cos(ra) * (1 - f) + Math.cos(rb) * f;
  const y = Math.sin(ra) * (1 - f) + Math.sin(rb) * f;
  if (Math.hypot(x, y) < 1e-9) return wrap(a);
  return wrap(Math.atan2(y, x) * 180 / Math.PI);
}

/** Gercek ruzgar acisi: rota ile ruzgarin GELDIGI yon arasindaki en kucuk aci, 0..180. */
export function trueWindAngle(courseDeg, windFromDeg) {
  if (!Number.isFinite(courseDeg) || !Number.isFinite(windFromDeg)) return NaN;
  const d = Math.abs(((windFromDeg - courseDeg) % 360 + 540) % 360 - 180);
  return d;
}

/**
 * Yelken acisi adi. Kruvazor icin ~45° altina orsa yapilamaz; motor ya da volta.
 * Etiketler Turkce denizcilik dilinde.
 */
export function pointOfSail(twa) {
  if (!Number.isFinite(twa)) return null;
  if (twa < 45) return { key: 'headwind', label: 'ruzgar burundan', sailable: false };
  if (twa < 70) return { key: 'closehauled', label: 'orsa', sailable: true };
  if (twa < 110) return { key: 'beam', label: 'apaz', sailable: true };
  if (twa < 150) return { key: 'broad', label: 'genis apaz', sailable: true };
  return { key: 'run', label: 'pupa', sailable: true };
}

/**
 * Bir etabi degerlendirir. severity: 0 sorun yok, 1 dikkat, 2 uyari.
 * Esikler kruvazor yelkenli icin makul varsayilanlar; ayarlanabilir.
 */
export function assessLeg({ courseDeg, wind, wave }, limits = {}) {
  const strongKn = limits.strongKn ?? 22;
  const galeKn = limits.galeKn ?? 30;
  const gustKn = limits.gustKn ?? 33;
  const waveWarnM = limits.waveWarnM ?? 1.5;
  const beamWaveM = limits.beamWaveM ?? 1.0;
  const motorBelowKn = limits.motorBelowKn ?? 6;

  const warnings = [];
  let severity = 0;
  const bump = (level) => { severity = Math.max(severity, level); };

  const twa = wind ? trueWindAngle(courseDeg, wind.dirDeg) : NaN;
  const sail = pointOfSail(twa);

  if (wind && Number.isFinite(wind.speedKn)) {
    if (wind.speedKn >= galeKn) { warnings.push(`${Math.round(wind.speedKn)} kn ruzgar — firtina siniri`); bump(2); }
    else if (wind.speedKn >= strongKn) { warnings.push(`${Math.round(wind.speedKn)} kn ruzgar — sert`); bump(1); }
    if (Number.isFinite(wind.gustKn) && wind.gustKn >= gustKn) { warnings.push(`hamle ${Math.round(wind.gustKn)} kn`); bump(2); }
    if (sail && !sail.sailable && wind.speedKn >= 8) { warnings.push('ruzgar burundan: volta ya da motor'); bump(1); }
    if (wind.speedKn < motorBelowKn) warnings.push('hafif hava: motor');
  }
  if (wave && Number.isFinite(wave.heightM)) {
    const relative = trueWindAngle(courseDeg, wave.dirDeg);
    if (wave.heightM >= waveWarnM) { warnings.push(`${wave.heightM.toFixed(1)} m dalga`); bump(2); }
    else if (wave.heightM >= beamWaveM && relative >= 60 && relative <= 120) {
      warnings.push(`${wave.heightM.toFixed(1)} m dalga bordadan`); bump(1);
    }
  }
  return { twa, sail, warnings, severity };
}

// ---------------------------------------------------------------- indirme

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    for (const key of Object.keys(parsed)) if (now - parsed[key].at > CACHE_MS) delete parsed[key];
    return parsed;
  } catch { return {}; }
}

function writeCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* dolu olabilir */ }
}

async function fetchMulti(url, params, signal) {
  const search = new URLSearchParams(params);
  const response = await fetch(`${url}?${search}`, { signal });
  if (!response.ok) throw new Error(`Hava servisi HTTP ${response.status}`);
  const data = await response.json();
  // Tek konumda nesne, coklu konumda dizi doner.
  return Array.isArray(data) ? data : [data];
}

/**
 * Noktalar ve her birine varis zamani (ms) icin ruzgar + dalga.
 * Sonuc: nokta basina {at, wind:{speedKn,gustKn,dirDeg}|null, wave:{heightM,dirDeg,periodS,swellM}|null}
 * ve {issued, forecastDays, source}.
 * Deniz modeli karada/kiyida NaN verebilir; o nokta icin wave null olur.
 */
export async function fetchRouteWeather(points, etasMs, { signal } = {}) {
  if (!points?.length) return { perPoint: [], issued: Date.now(), forecastDays: 0 };
  const latest = Math.max(...etasMs);
  const forecastDays = Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.ceil((latest - Date.now()) / 86400000) + 1));
  const lat = points.map(p => p.latitude.toFixed(3)).join(',');
  const lon = points.map(p => p.longitude.toFixed(3)).join(',');
  const hourBucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const cacheKey = `${lat}|${lon}|${forecastDays}|${hourBucket}`;
  const cache = readCache();
  let payload = cache[cacheKey]?.payload;

  if (!payload) {
    const common = { latitude: lat, longitude: lon, timezone: 'UTC', timeformat: 'unixtime', forecast_days: String(forecastDays) };
    const [windRows, waveRows] = await Promise.all([
      fetchMulti(FORECAST_URL, {
        ...common, hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m', wind_speed_unit: 'kn', models: 'best_match',
      }, signal),
      fetchMulti(MARINE_URL, {
        ...common, hourly: 'wave_height,wave_direction,wave_period,swell_wave_height',
      }, signal).catch(() => null), // dalga servisi dusse ruzgar yine gelsin
    ]);
    payload = { windRows, waveRows, issued: Date.now() };
    cache[cacheKey] = { at: Date.now(), payload };
    writeCache(cache);
  }

  const perPoint = points.map((point, i) => {
    const at = etasMs[i];
    const w = payload.windRows[i]?.hourly;
    const m = payload.waveRows?.[i]?.hourly;
    const wind = w ? {
      speedKn: interpolateLinear(w.time, w.wind_speed_10m, at),
      gustKn: interpolateLinear(w.time, w.wind_gusts_10m, at),
      dirDeg: interpolateDirection(w.time, w.wind_direction_10m, at),
    } : null;
    let wave = null;
    if (m) {
      const heightM = interpolateLinear(m.time, m.wave_height, at);
      if (Number.isFinite(heightM)) {
        wave = {
          heightM,
          dirDeg: interpolateDirection(m.time, m.wave_direction, at),
          periodS: interpolateLinear(m.time, m.wave_period, at),
          swellM: interpolateLinear(m.time, m.swell_wave_height, at),
        };
      }
    }
    return { at, wind: wind && Number.isFinite(wind.speedKn) ? wind : null, wave };
  });
  return { perPoint, issued: payload.issued, forecastDays, source: WIND_MODEL_NOTE };
}
