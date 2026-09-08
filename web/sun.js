// Gun dogumu / batimi (NOAA yaklasimi, -0,833° yukseklik = kirilma + gunes yarici).
// Tamamen yerel hesap; hicbir servise istek gitmez. Varis saatinin karanliga
// denk gelip gelmedigini gostermek icin kullanilir.

const RAD = Math.PI / 180;
const J1970 = 2440588, J2000 = 2451545, DAY_MS = 86400000;
const OBLIQUITY = RAD * 23.4397;
const HORIZON = RAD * -0.833;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);

function eclipticLongitude(anomaly) {
  const centre = RAD * (1.9148 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly) + 0.0003 * Math.sin(3 * anomaly));
  return anomaly + centre + RAD * 102.9372 + Math.PI;
}

const declination = (longitude) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(longitude));

const J0 = 0.0009;
const approxTransit = (hourAngle, lw, cycle) => J0 + (hourAngle + lw) / (2 * Math.PI) + cycle;
const solarTransit = (ds, anomaly, longitude) =>
  J2000 + ds + 0.0053 * Math.sin(anomaly) - 0.0069 * Math.sin(2 * longitude);

/**
 * @returns {{sunrise: Date, sunset: Date, noon: Date}} or null at polar day/night.
 */
export function sunTimes(date, latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const lw = RAD * -longitude, phi = RAD * latitude;
  const d = toDays(date);
  const cycle = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, cycle);
  const anomaly = solarMeanAnomaly(ds);
  const eclipticLon = eclipticLongitude(anomaly);
  const dec = declination(eclipticLon);
  const noon = solarTransit(ds, anomaly, eclipticLon);

  const cosH = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (!(cosH >= -1 && cosH <= 1)) return null;
  const hourAngle = Math.acos(cosH);
  const setJ = solarTransit(approxTransit(hourAngle, lw, cycle), anomaly, eclipticLon);
  return {
    sunrise: fromJulian(noon - (setJ - noon)),
    sunset: fromJulian(setJ),
    noon: fromJulian(noon),
  };
}
