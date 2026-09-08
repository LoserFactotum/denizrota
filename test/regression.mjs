// Regression against the recorded real-service run in evidence/.
// The JS engine must reproduce the C engine's result exactly: same decoded
// raster, same land/water mask byte for byte, same path, same distance.
// A drift here means the web app would route differently from the audited
// engine, so any mismatch is a hard failure.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readGeoTIFF } from '../engine/geotiff.js';
import { planningBounds, parseOSM, prepareGrid } from '../engine/grid.js';
import { routeOnGrid, minimumDepthFor, auditPath } from '../engine/planner.js';
import { sha256Hex } from '../engine/sources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'evidence');

const RASTER_FILE = 'e6e61d359c99e57e4c3cd2861c9df547ed6b339724e45dc43f6f9196e38bc591.tif';
const OSM_FILE = '0faa1657c042cc1dc0bb2a945768d7e09cb463b8810b699b1f7fde10148be9d6.json';

export async function run(check) {
  const expected = JSON.parse(await readFile(join(EVIDENCE, 'live-report.json'), 'utf8'));
  const rasterBytes = new Uint8Array(await readFile(join(EVIDENCE, RASTER_FILE)));
  const osmBytes = new Uint8Array(await readFile(join(EVIDENCE, OSM_FILE)));
  const expectedMask = new Uint8Array(await readFile(join(EVIDENCE, 'grid-mask.bin')));
  const expectedBounds = JSON.parse(await readFile(join(EVIDENCE, 'grid-bounds.json'), 'utf8'));

  check.equal(await sha256Hex(rasterBytes), expected.raster_sha256, 'evidence GeoTIFF sha256');
  check.equal(await sha256Hex(osmBytes), expected.osm_sha256, 'evidence Overpass sha256');

  // The recorded run used the original fixed 150 m cell and 0.18 deg margin.
  const anchors = [
    { name: 'Baslangic', latitude: expected.start[0], longitude: expected.start[1] },
    { name: 'Varis', latitude: expected.goal[0], longitude: expected.goal[1] },
  ];
  const bounds = planningBounds(anchors, { cell: 150, margin: 0.18 });
  check.equal(bounds.rows, expected.grid_rows, 'grid rows');
  check.equal(bounds.columns, expected.grid_columns, 'grid columns');
  check.equal(bounds.west, expectedBounds.west, 'bounds west');
  check.equal(bounds.south, expectedBounds.south, 'bounds south');
  check.equal(bounds.east, expectedBounds.east, 'bounds east');
  check.equal(bounds.north, expectedBounds.north, 'bounds north');

  const raster = await readGeoTIFF(rasterBytes);
  check.equal(raster.rows, expected.raster_rows, 'raster rows');
  check.equal(raster.columns, expected.raster_columns, 'raster columns');
  check.equal(raster.dy, expected.raster_step, 'raster latitude step');

  const features = parseOSM(JSON.parse(new TextDecoder().decode(osmBytes)), bounds);
  check.equal(features.coastWays, expected.coast_ways, 'coastline ways');
  check.equal(features.segmentCount, expected.coast_segments, 'coastline segments');
  check.equal(features.obstacles.length, expected.obstacle_shapes, 'obstacle shapes');
  check.equal(features.timestamp, expected.osm_timestamp, 'OSM database timestamp');

  const boat = { draft: 1.5, underKeel: 1, modelAllowance: 5, waterLevelDrop: 0, horizontalBuffer: 150 };
  check.equal(minimumDepthFor(boat), 7.5, 'minimum model depth threshold');
  const grid = prepareGrid({ bounds, raster, features, minimumDepth: minimumDepthFor(boat) });

  const counts = {};
  for (const value of grid.mask) counts[value] = (counts[value] ?? 0) + 1;
  for (const [value, count] of Object.entries(expected.mask_counts)) {
    check.equal(counts[value] ?? 0, count, `mask cells with value ${value}`);
  }
  check.equal(Object.keys(counts).length, Object.keys(expected.mask_counts).length, 'distinct mask values');
  check.equal(grid.mask.length, expectedMask.length, 'mask length');
  let firstDifference = -1;
  for (let i = 0; i < expectedMask.length; i++) {
    if (grid.mask[i] !== expectedMask[i]) { firstDifference = i; break; }
  }
  check.equal(firstDifference, -1, 'mask is byte-identical to the recorded run');

  const route = routeOnGrid({ grid, anchors, boat });
  check.equal(route.cells.length, expected.path_cells, 'path cells');
  check.equal(route.gridDistanceM / 1852, expected.grid_distance_nm, 'grid distance in nautical miles');
  check.equal(route.shallowestModelDepth, expected.minimum_model_depth, 'shallowest model depth on the path');
  check.equal(auditPath(grid, route.cells, boat), null, 'independent buffer audit of every path cell');

  const geojson = JSON.parse(await readFile(join(EVIDENCE, 'route.geojson'), 'utf8'));
  const expectedLine = geojson.geometry.coordinates;
  check.equal(expectedLine.length, route.cells.length, 'recorded geometry length');
  let geometryDifference = -1;
  for (let i = 0; i < route.cells.length; i++) {
    const row = Math.floor(route.cells[i] / bounds.columns), col = route.cells[i] % bounds.columns;
    const latitude = bounds.south + (bounds.rows - 1 - row + 0.5) * bounds.cell / bounds.metersPerLatitudeDegree;
    const longitude = bounds.west + (col + 0.5) * bounds.cell / bounds.metersPerLongitudeDegree;
    if (longitude !== expectedLine[i][0] || latitude !== expectedLine[i][1]) { geometryDifference = i; break; }
  }
  check.equal(geometryDifference, -1, 'path geometry matches the recorded run cell for cell');
}
