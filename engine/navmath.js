// Port of ios/DenizRota/Core/NavigationMath.c — same formulas, same refusals.
// Every function returns NaN rather than inventing a value for invalid input.

const EARTH_RADIUS_M = 6371000.0;
const RAD = Math.PI / 180.0;

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90.0 && latitude <= 90.0
    && longitude >= -180.0 && longitude <= 180.0;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  if (!validCoordinate(lat1, lon1) || !validCoordinate(lat2, lon2)) return NaN;
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  let a = Math.sin(dp / 2) * Math.sin(dp / 2)
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  a = Math.min(1, Math.max(0, a));
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  if (!validCoordinate(lat1, lon1) || !validCoordinate(lat2, lon2)) return NaN;
  if (Math.abs(lat1) >= 90.0) return NaN; // North reference undefined at the poles.
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  // Coincident and antipodal points have no unique initial bearing.
  if (Math.hypot(x, y) < 1e-12) return NaN;
  return (Math.atan2(y, x) / RAD + 360.0) % 360.0;
}

export function knotsFromMps(metersPerSecond) {
  if (!Number.isFinite(metersPerSecond) || metersPerSecond < 0) return NaN;
  return metersPerSecond * 3600.0 / 1852.0;
}

export function mpsFromKnots(knots) {
  if (!Number.isFinite(knots) || knots < 0) return NaN;
  return knots * 1852.0 / 3600.0;
}

export function etaSeconds(distanceM, metersPerSecond) {
  if (!Number.isFinite(distanceM) || distanceM < 0
    || !Number.isFinite(metersPerSecond) || metersPerSecond < 0) return NaN;
  if (distanceM === 0) return 0;
  // No invented ETA while stopped, or with an unavailable speed.
  if (metersPerSecond <= 0) return NaN;
  return distanceM / metersPerSecond;
}

/** Sum of great-circle legs through an ordered list of {latitude, longitude}. */
export function routeDistanceMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1].latitude, points[i - 1].longitude,
      points[i].latitude, points[i].longitude);
  }
  return total;
}

/**
 * Cross-track distance in metres from position p to the great-circle leg a→b,
 * and the along-track fraction. Positive cross-track means right of the leg.
 * Returns NaN when the leg has no length or an input is invalid.
 */
export function crossTrackMeters(pLat, pLon, aLat, aLon, bLat, bLon) {
  if (!validCoordinate(pLat, pLon) || !validCoordinate(aLat, aLon) || !validCoordinate(bLat, bLon)) return NaN;
  const d13 = distanceMeters(aLat, aLon, pLat, pLon) / EARTH_RADIUS_M;
  const t13 = initialBearingDeg(aLat, aLon, pLat, pLon) * RAD;
  const t12 = initialBearingDeg(aLat, aLon, bLat, bLon) * RAD;
  if (!Number.isFinite(t13) || !Number.isFinite(t12)) return NaN;
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * EARTH_RADIUS_M;
}
