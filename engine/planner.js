// End-to-end planning: download sources, build the grid, search each leg,
// then INDEPENDENTLY audit every returned cell before handing the route back.
// The audit is deliberate duplication: a routing bug must not be able to
// produce a route that looks fine.

import { readGeoTIFF } from './geotiff.js';
import {
  chooseCell, parseOSM, prepareGrid, indexOf, cellCentre, PlanningError,
  DEFAULT_MAX_CELLS, SHALLOW,
} from './grid.js';
import {
  plan, passableCells, DR_OK, DR_START_BLOCKED, DR_GOAL_BLOCKED, DR_NO_ROUTE, DR_CANCELLED,
  COVERED, LAND as FLAG_LAND,
} from './router.js';
import { BLOCKED, WATER, lineCells } from './mask.js';
import { initialBearingDeg } from './navmath.js';
import { fetchBathymetry, fetchOSM, sha256Hex, SOURCE_LABEL } from './sources.js';
import { distanceMeters, routeDistanceMeters } from './navmath.js';

export const DEFAULT_BOAT = Object.freeze({
  draft: 1.5,
  underKeel: 1.0,
  modelAllowance: 5.0,
  waterLevelDrop: 0.0,
  horizontalBuffer: 150.0,
});

export const MARGIN_LADDER = [0.25, 0.45, 0.8];

export function minimumDepthFor(boat) {
  return boat.draft + boat.underKeel + boat.modelAllowance + boat.waterLevelDrop;
}

export function validateBoat(boat) {
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  return inRange(boat?.draft, 0.1, 15) && inRange(boat?.underKeel, 0, 10)
    && inRange(boat?.modelAllowance, 0, 50) && inRange(boat?.waterLevelDrop, 0, 10)
    && inRange(boat?.horizontalBuffer, 0, 2000);
}

function vesselFor(boat) {
  return {
    draftM: boat.draft,
    underKeelClearanceM: boat.underKeel,
    dynamicAllowanceM: boat.modelAllowance,
    waterLevelLowerM: -boat.waterLevelDrop,
    horizontalBufferM: boat.horizontalBuffer,
  };
}

/**
 * Re-check a finished path against the grid, from scratch: every cell, every
 * cell inside the horizontal buffer, and both flanks of every diagonal step
 * must be covered and deep enough. Returns null when clean, else a description.
 */
export function auditPath(grid, path, boat, start, goal) {
  if (!path || !path.length) return 'yol bos';
  if (start !== undefined && path[0] !== start) return `yol istenen baslangictan (${start}) baslamiyor`;
  if (goal !== undefined && path[path.length - 1] !== goal) return `yol istenen varisa (${goal}) ulasmiyor`;
  const { rows, columns } = grid.bounds;
  const required = minimumDepthFor(boat);
  const radius = Math.ceil(boat.horizontalBuffer / grid.bounds.cell);
  const ok = (index) => grid.flags[index] === COVERED && grid.depths[index] >= required;
  const neighbourhood = (index) => {
    const r = Math.floor(index / columns), c = index % columns;
    if (r - radius < 0 || c - radius < 0 || r + radius >= rows || c + radius >= columns) {
      return `hucre ${index} grid kenarina ${radius} hucreden yakin`;
    }
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const j = (r + dr) * columns + (c + dc);
        if (!ok(j)) return `hucre ${index} cevresindeki ${j} gecilemez`;
      }
    }
    return null;
  };
  for (let k = 0; k < path.length; k++) {
    const problem = neighbourhood(path[k]);
    if (problem) return problem;
  }
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const ar = Math.floor(a / columns), ac = a % columns;
    const br = Math.floor(b / columns), bc = b % columns;
    if (Math.max(Math.abs(ar - br), Math.abs(ac - bc)) !== 1) return `hucre ${a} ile ${b} komsu degil`;
    if (ar !== br && ac !== bc) {
      for (const [rr, cc] of [[ar, bc], [br, ac]]) {
        const problem = neighbourhood(rr * columns + cc);
        if (problem) return `diyagonal gecis: ${problem}`;
      }
    }
  }
  return null;
}

export const BLOCK_REASONS = {
  unknown: 'burada derinlik verisi yok',
  land: 'kara olarak isaretli',
  obstacle: 'haritali bir engel/kiyi cizgisine degiyor',
  shallow: 'modele gore cok sig',
  unresolved: 'derinlik modeli burayi cozemiyor — kaynak gridi yaklasik 115 m, '
    + 'dar koylar ve kanallar kiyiyla karisip sifir derinlik olarak okunur',
  buffer: 'kiyi/engel payi bu noktaya sigmiyor',
  edge: 'hesaplanan alanin kenarina cok yakin',
};

/**
 * Explain WHY an endpoint cannot be used and what would fix it: the largest
 * horizontal buffer that still works there, and the nearest usable water.
 * Nothing is moved — the caller decides, the user confirms.
 */
export function diagnoseAnchor({ grid, boat, point, searchMetres = 12000 }) {
  const bounds = grid.bounds;
  const { rows, columns, cell } = bounds;
  const engineGrid = {
    rows, columns, cellSizeM: cell,
    chartedDepthM: grid.depths,
    depthUncertaintyM: new Float64Array(grid.total),
    flags: grid.flags,
  };
  const { pass, radius, prefix, stride } = passableCells(engineGrid, vesselFor(boat));
  // passableCells' own `required` is the right-hand side of
  //   depth + waterLevelLowerM - uncertainty >= required
  // so it deliberately EXCLUDES the water-level drop. Comparing a raw cell depth
  // against it would understate what the boat actually needs. The effective
  // per-cell threshold is minimumDepthFor(boat) — use that, so the explanation
  // and the router agree on the same rule.
  const required = minimumDepthFor(boat);
  const index = indexOf(bounds, point);
  if (pass[index]) return null;

  const row = Math.floor(index / columns), col = index % columns;
  let reason;
  if (grid.flags[index] === 0) reason = 'unknown';
  else if (grid.flags[index] === FLAG_LAND) reason = grid.mask[index] === BLOCKED ? 'obstacle' : 'land';
  else if (grid.depths[index] <= 0.5) reason = 'unresolved';
  else if (!(grid.depths[index] >= required)) reason = 'shallow';
  else if (row < radius || col < radius || row + radius >= rows || col + radius >= columns) reason = 'edge';
  else reason = 'buffer';

  // Largest clear square around the point → the largest buffer that still fits.
  let clear = -1;
  for (let rr = 0; ; rr++) {
    if (row - rr < 0 || col - rr < 0 || row + rr >= rows || col + rr >= columns) break;
    const r0 = row - rr, c0 = col - rr, r1 = row + rr + 1, c1 = col + rr + 1;
    const blocked = prefix[r1 * stride + c1] - prefix[r0 * stride + c1]
      - prefix[r1 * stride + c0] + prefix[r0 * stride + c0];
    if (blocked !== 0) break;
    clear = rr;
    if (rr > radius) break;
  }
  const usableBufferM = clear < 0 ? null : clear * cell;

  // Nearest usable water, reachable OVER WATER from the blocked point.
  //
  // A straight-line search is wrong here. Bencik Koyu is a narrow inlet that
  // almost cuts the Datca peninsula in two: the closest passable cell as the
  // crow flies lies in the NEXT GULF, across the isthmus. Suggesting it would
  // move the start to the wrong side of the peninsula. So the search walks the
  // water itself and never crosses land or a mapped obstacle.
  //
  // Traversal allows water, shallow water and the coast-touching band, but never
  // LAND and never UNKNOWN: land is what separates one sea from another, and an
  // unknown patch could otherwise bridge a headland. The suggested cell itself
  // still has to be fully passable under the strict rules.
  const total = rows * columns;
  const isSea = (i) => grid.mask[i] === WATER || grid.mask[i] === SHALLOW || grid.mask[i] === BLOCKED;
  const maxSteps = Math.ceil(searchMetres / cell);

  // Giris hucreleri: nokta denizdeyse kendisi, karadaysa en yakin deniz halkasi.
  const entries = [];
  if (isSea(index)) entries.push(index);
  else {
    const collect = (r, c) => {
      if (r < 0 || c < 0 || r >= rows || c >= columns) return;
      const i = r * columns + c;
      if (isSea(i)) entries.push(i);
    };
    for (let rr = 1; rr <= maxSteps && !entries.length; rr++) {
      for (let d = -rr; d <= rr; d++) {
        collect(row - rr, col + d); collect(row + rr, col + d);
        collect(row + d, col - rr); collect(row + d, col + rr);
      }
    }
  }

  const queue = new Int32Array(total);
  const visited = new Uint8Array(total);
  let head = 0, tail = 0;
  for (const i of entries) if (!visited[i]) { visited[i] = 1; queue[tail++] = i; }
  const push = (j) => { if (!visited[j] && isSea(j)) { visited[j] = 1; queue[tail++] = j; } };

  let best = null, waterSteps = 0, levelEnd = tail;
  while (head < tail && waterSteps <= maxSteps) {
    const i = queue[head++];
    if (pass[i]) { best = { index: i, steps: waterSteps }; break; }
    const r = Math.floor(i / columns), c = i - r * columns;
    if (r > 0) push(i - columns);
    if (r + 1 < rows) push(i + columns);
    if (c > 0) push(i - 1);
    if (c + 1 < columns) push(i + 1);
    if (head === levelEnd) { waterSteps++; levelEnd = tail; }
  }

  let nearest = null;
  if (best) {
    const bestRow = Math.floor(best.index / columns), bestCol = best.index % columns;
    nearest = {
      ...cellCentre(bounds, best.index, `${point.name ?? 'Nokta'} (acik su)`),
      distanceM: Math.hypot((bestCol - col) * cell, (bestRow - row) * cell),
      waterPathM: best.steps * cell,
    };
    nearest.bearingDeg = initialBearingDeg(point.latitude, point.longitude, nearest.latitude, nearest.longitude);
  }
  return {
    reason,
    reasonText: BLOCK_REASONS[reason],
    modelDepth: Number.isFinite(grid.depths[index]) ? grid.depths[index] : null,
    requiredDepth: required,
    bufferM: boat.horizontalBuffer,
    usableBufferM,
    nearest,
  };
}

/**
 * Turn the grid staircase into the legs a navigator would actually steer.
 *
 * A* on eight-connected cells can only turn in 45° steps, so its output zigzags
 * along anything that is not axis-aligned. This pulls the string taut: from each
 * anchor it reaches as far ahead as a STRAIGHT line stays entirely inside cells
 * that are passable with the full horizontal buffer, then makes that the next
 * turn. Nothing is smoothed across a cell the router would not have entered, so
 * the result is never less safe than the staircase — only shorter and steerable.
 */
function straighten(path, columns, isClear) {
  if (path.length < 3) return Array.from(path);
  const rowOf = (i) => Math.floor(i / columns);
  const colOf = (i) => i % columns;
  const clearBetween = (a, b) =>
    lineCells(rowOf(a), colOf(a), rowOf(b), colOf(b), (r, c) => isClear(r * columns + c));

  const out = [path[0]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let best = anchor + 1;
    // Walk forward while the straight line stays clear; stop at the last one that did.
    for (let j = anchor + 2; j < path.length; j++) {
      if (!clearBetween(path[anchor], path[j])) break;
      best = j;
    }
    out.push(path[best]);
    anchor = best;
  }
  return out;
}

/**
 * Re-check the straightened legs from scratch: every cell each straight segment
 * touches must be covered, deep enough, and clear across the whole buffer.
 * Returns null when clean, else a description.
 */
export function auditSegments(grid, cells, boat) {
  const { rows, columns } = grid.bounds;
  const required = minimumDepthFor(boat);
  const radius = Math.ceil(boat.horizontalBuffer / grid.bounds.cell);
  const ok = (index) => grid.flags[index] === COVERED && grid.depths[index] >= required;
  const clear = (index) => {
    const r = Math.floor(index / columns), c = index % columns;
    if (r - radius < 0 || c - radius < 0 || r + radius >= rows || c + radius >= columns) return false;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (!ok((r + dr) * columns + (c + dc))) return false;
      }
    }
    return true;
  };
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1], b = cells[k];
    let bad = -1;
    lineCells(Math.floor(a / columns), a % columns, Math.floor(b / columns), b % columns, (r, c) => {
      if (r < 0 || c < 0 || r >= rows || c >= columns) { bad = -2; return false; }
      const i = r * columns + c;
      if (!clear(i)) { bad = i; return false; }
      return true;
    });
    if (bad !== -1) return `duzlestirilmis etap ${k}: hucre ${bad} gecilemez`;
  }
  return null;
}

function metres(value) {
  return value >= 1000 ? `${(value / 1852).toFixed(2)} deniz mili` : `${Math.round(value)} m`;
}

function blockedError(point, diagnosis, status) {
  const parts = [`'${point.name ?? 'Nokta'}' bu haliyle kullanilamiyor: ${diagnosis?.reasonText ?? 'gecilemez alanda'}.`];
  if (diagnosis?.reason === 'shallow' && diagnosis.modelDepth !== null) {
    parts.push(`Model derinligi ${diagnosis.modelDepth.toFixed(1)} m, gereken ${diagnosis.requiredDepth.toFixed(1)} m.`);
  }
  if (diagnosis?.reason === 'unresolved') {
    parts.push('Burasi gercekte derin olabilir; uygulama bunu dogrulayamadigi icin rota baslatmiyor.');
  }
  if (diagnosis?.usableBufferM !== null && diagnosis?.usableBufferM !== undefined
    && diagnosis.usableBufferM < diagnosis.bufferM) {
    parts.push(`Kiyi/engel payini ${diagnosis.bufferM} m yerine en cok ${diagnosis.usableBufferM} m yaparsan bu nokta acilir.`);
  }
  if (diagnosis?.nearest) {
    const bearing = Number.isFinite(diagnosis.nearest.bearingDeg)
      ? `, ${Math.round(diagnosis.nearest.bearingDeg).toString().padStart(3, '0')}° yonunde` : '';
    const water = diagnosis.nearest.waterPathM > diagnosis.nearest.distanceM * 1.3
      ? ` (deniz yoluyla yaklasik ${metres(diagnosis.nearest.waterPathM)})` : '';
    parts.push(`Deniz yoluyla en yakin uygun su ${metres(diagnosis.nearest.distanceM)} uzakta${bearing}${water}.`);
  } else {
    parts.push('Deniz yoluyla ulasilabilir uygun su bulunamadi; noktayi haritada kendiniz tasiyin.');
  }
  parts.push('Nokta kendiliginden tasinmadi.');
  return new PlanningError(parts.join(' '), { blocked: point, diagnosis, status });
}

function legError(status, from, to) {
  if (status === DR_NO_ROUTE) {
    return new PlanningError(
      'Secilen derinlik ve uzaklik kosullariyla indirilen alanda rota bulunamadi.',
      { status, retryable: true });
  }
  if (status === DR_CANCELLED) return new PlanningError('Hesap iptal edildi.', { status });
  return new PlanningError(`Rota hesabi tamamlanamadi (${status}).`, { status });
}

/** Search every leg on a prepared grid and return the joined, audited geometry. */
export function routeOnGrid({ grid, anchors, boat, shouldCancel }) {
  // Mirrors the Swift route(): a cancelled plan must never come back as a route.
  const stopIfCancelled = () => {
    if (shouldCancel?.()) throw new PlanningError('Hesap iptal edildi.', { status: DR_CANCELLED });
  };
  stopIfCancelled();
  const bounds = grid.bounds;
  const vessel = vesselFor(boat);
  const uncertainty = new Float64Array(grid.total); // this adapter has no measured uncertainty
  const engineGrid = {
    rows: bounds.rows,
    columns: bounds.columns,
    cellSizeM: bounds.cell,
    chartedDepthM: grid.depths,
    depthUncertaintyM: uncertainty,
    flags: grid.flags,
  };
  // The same buffer-aware passability the router used, reused for straightening.
  const { pass } = passableCells(engineGrid, vessel);
  const isClear = (index) => pass[index] === 1;

  const points = [anchors[0]];
  const legs = [];
  const allCells = [];
  let shallowest = Infinity;
  let gridDistanceM = 0;
  for (let leg = 0; leg < anchors.length - 1; leg++) {
    stopIfCancelled();
    const from = anchors[leg], to = anchors[leg + 1];
    const start = indexOf(bounds, from), goal = indexOf(bounds, to);
    const result = plan(engineGrid, vessel, start, goal, { maxCells: DEFAULT_MAX_CELLS, shouldCancel });
    if (result.status === DR_START_BLOCKED || result.status === DR_GOAL_BLOCKED) {
      const point = result.status === DR_START_BLOCKED ? from : to;
      throw blockedError(point, diagnoseAnchor({ grid, boat, point }), result.status);
    }
    if (result.status !== DR_OK) throw legError(result.status, from, to);
    const problem = auditPath(grid, result.path, boat, start, goal);
    if (problem) {
      throw new PlanningError('Bagimsiz guvenlik denetimi rotayi reddetti; rota verilmedi.', { problem });
    }
    let legShallowest = Infinity;
    for (const i of result.path) {
      if (grid.depths[i] < legShallowest) legShallowest = grid.depths[i];
      allCells.push(i);
    }
    if (legShallowest < shallowest) shallowest = legShallowest;
    gridDistanceM += result.distanceM;
    const straightened = straighten(result.path, bounds.columns, isClear);
    const segmentProblem = auditSegments(grid, straightened, boat);
    if (segmentProblem) {
      throw new PlanningError('Bagimsiz guvenlik denetimi duzlestirilmis rotayi reddetti; rota verilmedi.',
        { problem: segmentProblem });
    }
    legs.push({
      from: from.name, to: to.name,
      cells: result.count,
      turns: straightened.length,
      gridDistanceM: result.distanceM,
      shallowestModelDepth: legShallowest,
    });
    // Exact anchors connect to the centres of their own fully checked cells.
    for (const index of straightened) points.push(cellCentre(bounds, index));
    points.push(to);
  }
  stopIfCancelled();
  const deduped = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && distanceMeters(last.latitude, last.longitude, p.latitude, p.longitude) < 0.1) continue;
    deduped.push({ ...p });
  }
  return {
    points: deduped,
    legs,
    cells: allCells,
    gridDistanceM,
    distanceM: routeDistanceMeters(deduped),
    shallowestModelDepth: shallowest,
  };
}

/**
 * Full plan. Downloads, builds and searches; on "no route" it widens the search
 * area once or twice and tries again, reporting that it did so.
 */
export async function planRoute({
  anchors, boat = DEFAULT_BOAT, cache, signal, onProgress,
  maxCells = DEFAULT_MAX_CELLS, marginLadder = MARGIN_LADDER, cellOverride,
}) {
  if (!validateBoat(boat)) throw new PlanningError('Tekne olculerini kontrol edin.');
  const minimumDepth = minimumDepthFor(boat);
  const shouldCancel = () => signal?.aborted === true;
  const attempts = [];
  let lastRetryable = null;

  for (let attempt = 0; attempt < marginLadder.length; attempt++) {
    const margin = marginLadder[attempt];
    if (signal?.aborted) throw new PlanningError('Hesap iptal edildi.');
    const ladder = cellOverride ? [cellOverride] : undefined;
    const { cell, bounds } = chooseCell(anchors, { margin, maxCells, ladder });
    const area = `${bounds.columns}×${bounds.rows} hucre · ${cell} m`;
    onProgress?.(attempt === 0
      ? `Derinlik modeli indiriliyor… (${area})`
      : `Alan genisletildi, yeniden deneniyor… (${area})`, 0.05);

    const bathy = await fetchBathymetry(bounds, { cache, signal });
    onProgress?.('Derinlik dosyasi cozuluyor…', 0.25);
    const raster = await readGeoTIFF(bathy.bytes);
    if (!(raster.dx <= 1 / 900) || !(raster.dy <= 1 / 900)) {
      throw new PlanningError('Derinlik servisinin cozunurlugu beklenen gridle uyusmuyor.',
        { dx: raster.dx, dy: raster.dy });
    }

    onProgress?.('Kiyi, kayalik, batik ve engeller indiriliyor…', 0.35);
    const osm = await fetchOSM(bounds, {
      cache, signal, onProgress: (text) => onProgress?.(text, 0.35),
    });
    let osmDocument;
    try {
      osmDocument = JSON.parse(new TextDecoder().decode(osm.bytes));
    } catch {
      throw new PlanningError('OpenStreetMap yaniti okunamadi.');
    }
    const features = parseOSM(osmDocument, bounds);

    const grid = prepareGrid({
      bounds, raster, features, minimumDepth, maxCells, shouldCancel,
      onProgress: (message) => onProgress?.(message, 0.5),
    });

    onProgress?.('Derinlik ve engellere gore rota araniyor…', 0.75);
    let route;
    try {
      route = routeOnGrid({ grid, anchors, boat, shouldCancel });
    } catch (error) {
      attempts.push({ margin, cell, cells: bounds.count, error: error.message });
      if (error instanceof PlanningError && error.detail?.retryable && attempt + 1 < marginLadder.length) {
        lastRetryable = error;
        continue;
      }
      throw error;
    }

    if (signal?.aborted) throw new PlanningError('Hesap iptal edildi.');
    const [bathymetrySHA256, osmSHA256] = await Promise.all([sha256Hex(bathy.bytes), sha256Hex(osm.bytes)]);
    onProgress?.('Rota hesaplandi', 1);
    return {
      ...route,
      boat,
      minimumDepth,
      bounds,
      grid,
      anchors: anchors.map(a => ({ ...a })),
      provenance: {
        calculatedAt: Date.now(),
        sourceLabel: SOURCE_LABEL,
        bathymetryDownloadedAt: bathy.downloadedAt,
        bathymetryFromCache: bathy.fromCache,
        osmDownloadedAt: osm.downloadedAt,
        osmFromCache: osm.fromCache,
        osmTimestamp: features.timestamp,
        bathymetryURL: bathy.url,
        osmQuery: osm.query,
        bathymetrySHA256,
        osmSHA256,
        sourceLatitudeStep: raster.dy,
        cellMeters: bounds.cell,
        margin,
        widenedSearchArea: attempt > 0,
        attempts,
        coastWays: features.coastWays,
        coastSegments: features.segmentCount,
        obstacleCount: features.obstacles.length,
        unknownCellCount: grid.unknown,
        shallowCellCount: grid.shallow,
        totalCellCount: grid.total,
      },
    };
  }
  throw lastRetryable ?? new PlanningError('Rota bulunamadi.');
}

export { SHALLOW };
