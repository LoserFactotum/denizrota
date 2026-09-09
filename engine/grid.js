// Planning area, OSM feature assembly and grid preparation.
// Port of ios/DenizRota/MarineDataService.swift (PlanningBounds, OSMFeatures,
// prepare) with two deliberate changes, both conservative:
//
//  1. The planning cell is adaptive (finer than 150 m where the area allows).
//     Depth sampling compensates: a cell smaller than a source pixel still
//     takes the shallowest value over a full source-pixel window, so a finer
//     grid resolves coastline and obstacle geometry without ever seeing less
//     of the bathymetry than a coarse cell would. See minDepth's padX/padY.
//  2. The fixed Marmaris-Datca-Bodrum latitude/longitude gate is gone. The
//     only limit left is the cell budget, which is about compute, not safety.

import { minDepth } from './geotiff.js';
import { blockShape, coastMask, cellIndex, UNKNOWN, WATER, LAND, BLOCKED } from './mask.js';
import { COVERED, LAND as FLAG_LAND } from './router.js';

export const SHALLOW = 8; // preview-only mask value: covered but below the threshold
export const METERS_PER_LATITUDE_DEGREE = 6371000.0 * Math.PI / 180;
// Single multiply by a precomputed constant, matching the reference implementation's
// radians(). Keeping the operation order identical keeps cell boundaries identical.
const DEG_TO_RAD = Math.PI / 180;
export const CELL_LADDER = [40, 50, 60, 75, 100, 125, 150];
export const DEFAULT_MAX_CELLS = 1600000;

export class PlanningError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

/**
 * Metric planning area covering every anchor plus a margin, snapped to 0.05°.
 * Local equirectangular metres — not UTM; a regional approximation.
 */
export function planningBounds(anchors, { cell = 150, margin = 0.25, maxCells = DEFAULT_MAX_CELLS } = {}) {
  if (!Array.isArray(anchors) || anchors.length < 2 || anchors.length > 20) {
    throw new PlanningError('2 ile 20 arasinda rota noktasi secin.');
  }
  for (const a of anchors) {
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)
      || Math.abs(a.latitude) > 90 || Math.abs(a.longitude) > 180) {
      throw new PlanningError('Rota noktalarindan biri gecerli bir koordinat degil.');
    }
  }
  const lats = anchors.map(a => a.latitude), lons = anchors.map(a => a.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const ky = METERS_PER_LATITUDE_DEGREE;
  const kx = ky * Math.cos((minLat + maxLat) / 2 * DEG_TO_RAD);
  const west = Math.floor((minLon - margin) * 20) / 20;
  const south = Math.floor((minLat - margin) * 20) / 20;
  const columns = Math.ceil((Math.ceil((maxLon + margin) * 20) / 20 - west) * kx / cell);
  const rows = Math.ceil((Math.ceil((maxLat + margin) * 20) / 20 - south) * ky / cell);
  if (!(rows > 0) || !(columns > 0)) throw new PlanningError('Planlama alani hesaplanamadi.');
  if (rows * columns > maxCells) {
    throw new PlanningError('Bu rota tek hesap icin cok genis. Daha kisa etaplara bol.',
      { rows, columns, cells: rows * columns, maxCells });
  }
  return {
    cell, margin, west, south, rows, columns,
    metersPerLatitudeDegree: ky, metersPerLongitudeDegree: kx,
    get east() { return west + columns * cell / kx; },
    get north() { return south + rows * cell / ky; },
    get count() { return rows * columns; },
  };
}

/** Finest cell from the ladder whose grid fits the budget, for this margin. */
export function chooseCell(anchors, { margin = 0.25, maxCells = DEFAULT_MAX_CELLS, ladder = CELL_LADDER } = {}) {
  for (const cell of ladder) {
    try {
      const bounds = planningBounds(anchors, { cell, margin, maxCells });
      return { cell, bounds };
    } catch (error) {
      if (!(error instanceof PlanningError) || !error.detail) throw error;
    }
  }
  throw new PlanningError('Bu rota en kaba hesap gridiyle bile cok genis. Daha kisa etaplara bol.');
}

export function project(bounds, latitude, longitude) {
  return {
    x: (longitude - bounds.west) * bounds.metersPerLongitudeDegree,
    y: (latitude - bounds.south) * bounds.metersPerLatitudeDegree,
  };
}

export function indexOf(bounds, point) {
  const p = project(bounds, point.latitude, point.longitude);
  const index = cellIndex(bounds.rows, bounds.columns, bounds.cell, p.x, p.y);
  if (index < 0) throw new PlanningError(`'${point.name ?? 'Nokta'}' indirilen alanin disinda.`);
  return index;
}

export function cellCentre(bounds, index, name = 'Rota donusu') {
  const row = Math.floor(index / bounds.columns), col = index % bounds.columns;
  return {
    name,
    latitude: bounds.south + (bounds.rows - 1 - row + 0.5) * bounds.cell / bounds.metersPerLatitudeDegree,
    longitude: bounds.west + (col + 0.5) * bounds.cell / bounds.metersPerLongitudeDegree,
  };
}

export function downloadBBox(bounds) {
  return [bounds.west - 0.01, bounds.south - 0.01, bounds.east + 0.01, bounds.north + 0.01].join(',');
}
/**
 * Overpass kutusu DISARI dogru 0,25 dereceye yuvarlanir.
 *
 * Boylece ayni bolgedeki her rota AYNI sorgu metnini uretir ve gunluk
 * onbellekten karsilanir. Teknede zayif LTE'de ve Overpass'in IP basina slot
 * limiti altinda asil sorun tekrar tekrar indirmekti; bu onu bitiriyor.
 * Bedeli olculdu: Datca-Marmaris kutusu icin 2,4 MB -> 3,4 MB, 10 -> 11 sn.
 *
 * Daha genis kutu sonucu DEGISTIRMEZ: grid disindaki nesneler hicbir hucreye
 * dokunmaz (blockShape sinir disini atlar), kiyi butunluk kontrolu yalnizca
 * grid ICINDEKI dugumlere bakar, ve tarama cizgisinin batisindaki fazladan
 * kesisimler kara/deniz paritesini yalnizca daha saglam kurar.
 */
export const OVERPASS_SNAP_DEGREES = 0.25;

export function overpassBBox(bounds, step = OVERPASS_SNAP_DEGREES) {
  const snap = (value, direction) => {
    const snapped = direction < 0 ? Math.floor(value / step) * step : Math.ceil(value / step) * step;
    return Number(snapped.toFixed(4));
  };
  return [
    snap(bounds.south - 0.01, -1), snap(bounds.west - 0.01, -1),
    snap(bounds.north + 0.01, 1), snap(bounds.east + 0.01, 1),
  ].join(',');
}

/**
 * Assemble OSM coastlines and obstacles in grid metres.
 * Throws rather than guessing: a broken coastline or an unclosed obstacle area
 * would otherwise be silently treated as open water.
 */
export function parseOSM(document, bounds) {
  if (!document || !Array.isArray(document.elements) || document.elements.length >= 100000 || document.remark) {
    throw new PlanningError('OpenStreetMap yaniti eksik veya zaman asimina ugradi. '
      + 'Engel verisi tamamlanmadan rota olusturulmaz.', { remark: document?.remark });
  }
  const timestamp = document.osm3s?.timestamp_osm_base ?? 'Tarih belirtilmedi';
  const toPoint = (p) => {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)
      || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
      throw new PlanningError('Engel/kiyi verisinde eksik koordinat var.');
    }
    return project(bounds, p.lat, p.lon);
  };
  const geometry = (element) => {
    if (element.type === 'node') return [toPoint(element)];
    if (!Array.isArray(element.geometry) || !element.geometry.length) {
      throw new PlanningError('Harita nesnesinin geometrisi eksik.');
    }
    return element.geometry.map(toPoint);
  };
  const equal = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;

  const coast = [];
  const obstacles = [];
  const balance = new Map();
  let coastWays = 0;
  for (const element of document.elements) {
    const tags = element.tags ?? {};
    if (tags.natural === 'coastline') {
      coastWays++;
      const g = geometry(element);
      const nodes = element.nodes;
      if (!Array.isArray(nodes) || nodes.length !== g.length || g.length < 2) {
        throw new PlanningError('Kiyi verisi birlestirilemiyor.');
      }
      for (let i = 1; i < g.length; i++) {
        coast.push(g[i - 1].x, g[i - 1].y, g[i].x, g[i].y);
        let a = balance.get(nodes[i - 1]);
        if (!a) { a = { incoming: 0, outgoing: 0, p: g[i - 1] }; balance.set(nodes[i - 1], a); }
        a.outgoing++;
        let z = balance.get(nodes[i]);
        if (!z) { z = { incoming: 0, outgoing: 0, p: g[i] }; balance.set(nodes[i], z); }
        z.incoming++;
      }
    } else if (element.type === 'relation') {
      if (!Array.isArray(element.members)) throw new PlanningError('Engel alaninin uyeleri eksik.');
      // Assemble outer ways; inner holes remain blocked conservatively.
      const pieces = element.members.filter(m => m.role !== 'inner').map(geometry);
      while (pieces.length) {
        const ring = pieces.shift();
        while (ring.length > 1 && !equal(ring[0], ring[ring.length - 1])) {
          const i = pieces.findIndex(p => equal(p[0], ring[ring.length - 1]) || equal(p[p.length - 1], ring[ring.length - 1]));
          if (i < 0) {
            throw new PlanningError('Engel alani kapatilamadi; eksik alani bos deniz saymamak icin hesap durdu.',
              { relation: element.id });
          }
          const part = pieces.splice(i, 1)[0];
          if (equal(part[part.length - 1], ring[ring.length - 1])) part.reverse();
          for (let k = 1; k < part.length; k++) ring.push(part[k]);
        }
        obstacles.push({ points: ring, fill: ring.length >= 4 });
      }
    } else {
      const g = geometry(element);
      obstacles.push({ points: g, fill: g.length >= 4 && equal(g[0], g[g.length - 1]) });
    }
  }
  const segmentCount = coast.length / 4;
  if (!segmentCount || segmentCount > 300000) {
    throw new PlanningError('Bu alanin kiyi verisi alinamadi.', { segmentCount });
  }
  // Every internal coastline node must have exactly one incoming and outgoing edge.
  const gaps = [];
  const widthM = bounds.columns * bounds.cell, heightM = bounds.rows * bounds.cell;
  for (const [id, node] of balance) {
    if (node.p.x > 0 && node.p.x < widthM && node.p.y > 0 && node.p.y < heightM
      && (node.incoming !== 1 || node.outgoing !== 1)) {
      gaps.push({
        id,
        latitude: bounds.south + node.p.y / bounds.metersPerLatitudeDegree,
        longitude: bounds.west + node.p.x / bounds.metersPerLongitudeDegree,
      });
    }
  }
  if (gaps.length) {
    throw new PlanningError('Indirilen alanin icinde kopuk veya cakisan kiyi cizgisi var. Hesap tamamlanamadi.',
      { gaps: gaps.slice(0, 10), gapCount: gaps.length });
  }
  return { coast: Float64Array.from(coast), segmentCount, obstacles, timestamp, coastWays };
}

/**
 * Build the routing grid: land/water mask, obstacle paint, per-cell shallowest
 * model depth. Unknown cells stay unknown. Nothing is interpolated.
 */
export function prepareGrid({ bounds, raster, features, minimumDepth, onProgress, shouldCancel, maxCells = DEFAULT_MAX_CELLS }) {
  const { rows, columns, cell } = bounds;
  const total = rows * columns;
  const mask = new Uint8Array(total);
  // Same three cancellation points as the Swift prepare(): a large grid can take
  // seconds, and the user must be able to stop it.
  const stopIfCancelled = () => {
    if (shouldCancel?.()) throw new PlanningError('Hesap iptal edildi.');
  };
  stopIfCancelled();
  onProgress?.('Kiyi sinirlari hesaplaniyor…');
  const maskResult = coastMask(rows, columns, cell, features.coast, features.segmentCount, mask, maxCells);
  if (maskResult !== 0) throw new PlanningError(`Kiyi siniri olusturulamadi (${maskResult}).`);

  onProgress?.('Kayalik, batik ve engeller isleniyor…');
  for (const shape of features.obstacles) {
    stopIfCancelled();
    const flat = new Float64Array(shape.points.length * 2);
    for (let i = 0; i < shape.points.length; i++) {
      flat[i * 2] = shape.points[i].x;
      flat[i * 2 + 1] = shape.points[i].y;
    }
    blockShape(rows, columns, cell, flat, shape.points.length, shape.fill, mask);
  }

  onProgress?.('Derinlik modeli hucrelere isleniyor…');
  const ky = bounds.metersPerLatitudeDegree, kx = bounds.metersPerLongitudeDegree;
  const cellLonDeg = cell / kx;
  const cellLatDeg = cell / ky;
  // A planning cell finer than a source pixel still samples a full pixel window.
  const padX = Math.max(0, (raster.dx - cellLonDeg) / 2);
  const padY = Math.max(0, (raster.dy - cellLatDeg) / 2);

  const depths = new Float64Array(total).fill(NaN);
  const flags = new Uint8Array(total);
  let unknown = 0, shallow = 0, shallowest = Infinity;
  const north = bounds.north, west = bounds.west;
  for (let row = 0; row < rows; row++) {
    if ((row & 31) === 0) stopIfCancelled();
    // (row * cell) / ky, not row * (cell / ky): same order as the reference.
    const cellNorth = north - row * cell / ky;
    const cellSouth = cellNorth - cellLatDeg;
    const rowBase = row * columns;
    for (let col = 0; col < columns; col++) {
      const i = rowBase + col;
      if (mask[i] === UNKNOWN) { unknown++; continue; }
      if (mask[i] !== WATER) { flags[i] = FLAG_LAND; continue; }
      const cellWest = west + col * cell / kx;
      const depth = minDepth(raster, cellWest, cellSouth, cellWest + cellLonDeg, cellNorth, padX, padY);
      if (!Number.isFinite(depth)) { mask[i] = UNKNOWN; unknown++; continue; }
      depths[i] = depth;
      flags[i] = COVERED;
      if (depth < shallowest) shallowest = depth;
      if (depth < minimumDepth) { mask[i] = SHALLOW; shallow++; }
    }
  }
  if (!flags.includes(COVERED)) {
    throw new PlanningError('Indirilen alanda kullanilabilir deniz/derinlik verisi bulunamadi.');
  }
  return { bounds, mask, depths, flags, unknown, shallow, total, shallowestModelDepth: shallowest };
}
