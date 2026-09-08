// Opt-in real-service check: downloads EMODnet bathymetry and OSM obstacles for
// a real leg and runs the same engine the web app runs. Uses the network.
//
//   node test/live.mjs --from 36.7807,28.0425 --to 36.6700,27.5040 --out evidence/bencik-palamut
//
// Writes live-report.json, route.geojson and grid-mask.bin into --out so the run
// is reproducible and inspectable.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { planRoute, DEFAULT_BOAT, minimumDepthFor } from '../engine/planner.js';
import { PlanningError } from '../engine/grid.js';

class FileCache {
  constructor(directory) { this.directory = directory; }
  path(key) { return join(this.directory, key + '.bin'); }
  async get(key) {
    try {
      const file = this.path(key);
      if (!existsSync(file)) return null;
      const stamp = JSON.parse(await readFile(file + '.json', 'utf8'));
      return { bytes: new Uint8Array(await readFile(file)), downloadedAt: stamp.downloadedAt };
    } catch { return null; }
  }
  async put(key, bytes, downloadedAt) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(key), bytes);
    await writeFile(this.path(key) + '.json', JSON.stringify({ downloadedAt }));
  }
}

function parsePair(text, label) {
  const parts = String(text).split(',').map(v => Number(v.trim().replace(',', '.')));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    throw new Error(`${label} "enlem,boylam" olmali (ornek 36.7807,28.0425)`);
  }
  return { latitude: parts[0], longitude: parts[1] };
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const from = { name: args.get('from-name') ?? 'Baslangic', ...parsePair(args.get('from') ?? '36.7807,28.0425', '--from') };
const to = { name: args.get('to-name') ?? 'Varis', ...parsePair(args.get('to') ?? '36.6700,27.5040', '--to') };
const via = (args.get('via') ?? '').split(';').filter(Boolean)
  .map((text, i) => ({ name: `Ara nokta ${i + 1}`, ...parsePair(text, '--via') }));
const outDir = resolve(args.get('out') ?? 'evidence/live');
const boat = { ...DEFAULT_BOAT };
for (const key of ['draft', 'underKeel', 'modelAllowance', 'waterLevelDrop', 'horizontalBuffer']) {
  if (args.has(key)) boat[key] = Number(args.get(key));
}
const speedKnots = Number(args.get('speed') ?? 5);

const anchors = [from, ...via, to];
console.log(`Rota: ${anchors.map(a => `${a.latitude.toFixed(4)},${a.longitude.toFixed(4)}`).join(' -> ')}`);
console.log(`Tekne: su cekimi ${boat.draft} m, omurga alti ${boat.underKeel} m, model payi ${boat.modelAllowance} m, `
  + `su dususu ${boat.waterLevelDrop} m, kiyi payi ${boat.horizontalBuffer} m -> gereken model derinligi ${minimumDepthFor(boat)} m`);

const cache = new FileCache(join(outDir, 'cache'));
const started = Date.now();
let route;
try {
  route = await planRoute({
    anchors, boat, cache,
    cellOverride: args.has('cell') ? Number(args.get('cell')) : undefined,
    onProgress: (message) => console.log('  ' + message),
  });
} catch (error) {
  console.error('\nBASARISIZ: ' + error.message);
  if (error instanceof PlanningError && error.detail) {
    console.error('Ayrinti: ' + JSON.stringify(error.detail, null, 2).slice(0, 2000));
  }
  process.exit(1);
}

const seconds = route.distanceM / (speedKnots * 1852 / 3600);
const report = {
  anchors, boat,
  minimumModelDepth: route.minimumDepth,
  cellMeters: route.bounds.cell,
  gridRows: route.bounds.rows,
  gridColumns: route.bounds.columns,
  west: route.bounds.west, south: route.bounds.south,
  east: route.bounds.east, north: route.bounds.north,
  pathCells: route.cells.length,
  waypoints: route.points.length,
  gridDistanceNm: route.gridDistanceM / 1852,
  routeDistanceNm: route.distanceM / 1852,
  durationHoursAtSpeed: seconds / 3600,
  speedKnots,
  shallowestModelDepthOnRoute: route.shallowestModelDepth,
  legs: route.legs,
  ...route.provenance,
  elapsedMs: Date.now() - started,
  validation: 'JS engine: numeric GeoTIFF decode + coast/obstacle mask + A*, '
    + 'every returned cell and its full horizontal buffer re-checked independently.',
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'live-report.json'), JSON.stringify(report, null, 2));
await writeFile(join(outDir, 'route.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Rota', ...report, legs: undefined },
      geometry: { type: 'LineString', coordinates: route.points.map(p => [p.longitude, p.latitude]) },
    },
    ...anchors.map(a => ({
      type: 'Feature',
      properties: { name: a.name },
      geometry: { type: 'Point', coordinates: [a.longitude, a.latitude] },
    })),
  ],
}));
await writeFile(join(outDir, 'grid-mask.bin'), Buffer.from(route.grid.mask));

const { legs, ...headline } = report;
console.log('\n' + JSON.stringify({
  cellMeters: headline.cellMeters,
  grid: `${headline.gridColumns}x${headline.gridRows}`,
  pathCells: headline.pathCells,
  waypoints: headline.waypoints,
  routeDistanceNm: Number(headline.routeDistanceNm.toFixed(3)),
  durationHoursAtSpeed: Number(headline.durationHoursAtSpeed.toFixed(2)),
  shallowestModelDepthOnRoute: headline.shallowestModelDepthOnRoute,
  unknownCellCount: headline.unknownCellCount,
  obstacleCount: headline.obstacleCount,
  coastWays: headline.coastWays,
  widenedSearchArea: headline.widenedSearchArea,
  osmTimestamp: headline.osmTimestamp,
  elapsedMs: headline.elapsedMs,
}, null, 2));
console.log(`\nGECTI: gercek veriyle rota bulundu ve bagimsiz denetimden gecti. Ciktilar: ${outDir}`);
