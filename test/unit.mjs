// Ports of the audited C/Python test suites:
//   ios/tests/NavigationMathTests.c
//   ios/tests/AutoRouterTests.c      (including the 300 Dijkstra comparisons)
//   ios/tests/MarineGridTests.py     (32 TIFF encodings, truncation, fuzzing, masks)
// Same scenarios, same seeds, so a divergence between the C engine and this
// port shows up as a failing check rather than as a wrong route at sea.

import { distanceMeters, initialBearingDeg, knotsFromMps, mpsFromKnots, etaSeconds } from '../engine/navmath.js';
import { readGeoTIFF, minDepth } from '../engine/geotiff.js';
import { blockShape, coastMask, cellIndex } from '../engine/mask.js';
import {
  plan, COVERED, LAND, OBSTACLE, RESTRICTED,
  DR_OK, DR_INVALID_INPUT, DR_START_BLOCKED, DR_GOAL_BLOCKED, DR_NO_ROUTE, DR_OUTPUT_TOO_SMALL,
} from '../engine/router.js';

// ---------------------------------------------------------------- helpers

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.length; }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

function packValues(type, values, little) {
  const size = { 3: 2, 4: 4, 12: 8 }[type];
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    if (type === 3) view.setUint16(i * 2, value, little);
    else if (type === 4) view.setUint32(i * 4, value, little);
    else view.setFloat64(i * 8, value, little);
  });
  return out;
}

function packU32(value, little) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, little);
  return out;
}

/** Port of MarineGridTests.py fixture(): a 3x2 GeoTIFF in 32 valid encodings. */
async function tiffFixture({ little = false, compressed = false, pixelPoint = false, matrix = false, signed = false, pad = 0 } = {}) {
  const values = [-10, -20, 3, -40, -9999, -60];
  const raw = new Uint8Array(signed ? 12 : 24);
  const rawView = new DataView(raw.buffer);
  values.forEach((value, i) => {
    if (signed) rawView.setInt16(i * 2, value, little);
    else rawView.setFloat32(i * 4, value, little);
  });
  let payload = compressed ? await deflate(raw) : raw;
  // pad: declared byte count longer than the actual stream. zlib's uncompress()
  // ignores those bytes, so the reader must too.
  if (pad) {
    const padded = new Uint8Array(payload.length + pad);
    padded.set(payload, 0);
    payload = padded;
  }

  const fields = new Map([
    [256, [4, [3]]], [257, [4, [2]]], [258, [3, [signed ? 16 : 32]]],
    [259, [3, [compressed ? 8 : 1]]], [262, [3, [1]]], [273, [4, [0]]],
    [277, [3, [1]]], [278, [4, [2]]], [279, [4, [payload.length]]],
    [339, [3, [signed ? 2 : 3]]],
    [34735, [3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, pixelPoint ? 2 : 1, 2048, 0, 1, 4326]]],
    [42113, [2, new TextEncoder().encode('-9999\0')]],
  ]);
  if (matrix) fields.set(34264, [12, [0.01, 0, 0, 27, 0, -0.01, 0, 37, 0, 0, 0, 0, 0, 0, 0, 1]]);
  else { fields.set(33550, [12, [0.01, 0.01, 0]]); fields.set(33922, [12, [0, 0, 0, 27, 37, 0]]); }

  const tags = [...fields.keys()].sort((a, b) => a - b);
  const start = 8 + 2 + tags.length * 12 + 4;
  const extras = [];
  const entries = [];
  for (const tag of tags) {
    const [type, value] = fields.get(tag);
    const bytes = type === 2 ? value : packValues(type, value, little);
    let offset;
    if (bytes.length <= 4) {
      offset = new Uint8Array(4);
      offset.set(bytes, 0);
    } else {
      offset = packU32(start + extras.length, little);
      extras.push(...bytes);
    }
    entries.push({ tag, type, count: value.length, offset });
  }
  const dataStart = start + extras.length;
  for (const entry of entries) if (entry.tag === 273) entry.offset = packU32(dataStart, little);

  const out = [];
  out.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]));
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 42, little);
  headerView.setUint32(2, 8, little);
  headerView.setUint16(6, tags.length, little);
  out.push(...header);
  for (const entry of entries) {
    const head = new Uint8Array(8);
    const view = new DataView(head.buffer);
    view.setUint16(0, entry.tag, little);
    view.setUint16(2, entry.type, little);
    view.setUint32(4, entry.count, little);
    out.push(...head, ...entry.offset);
  }
  out.push(...packU32(0, little), ...extras, ...payload);
  return new Uint8Array(out);
}

async function fails(bytes) {
  try { await readGeoTIFF(bytes); return false; } catch { return true; }
}

// ---------------------------------------------------------------- suites

function navigationMath(check) {
  const near = (actual, expected, tolerance, label) => check.close(actual, expected, tolerance, label);
  const undef = (actual, label) => check.ok(Number.isNaN(actual), label);

  near(distanceMeters(0, 0, 0, 1), 111194.92664455874, 1e-6, 'bir derece boylam, ekvator');
  near(distanceMeters(36, 28, 37, 28), 111194.92664455874, 1e-6, 'bir derece enlem');
  near(distanceMeters(36.7, 28.1, 36.7, 28.1), 0, 1e-6, 'ayni nokta');
  near(distanceMeters(0, 179.5, 0, -179.5), 111194.92664455874, 1e-6, 'tarih cizgisi gecisi');
  near(distanceMeters(0, 0, 0, 180), 20015086.79602057, 1e-6, 'yarim dunya');
  near(distanceMeters(89, 0, 90, 0), 111194.92664455874, 1e-6, 'kutba bir derece');
  near(distanceMeters(90, -180, 90, 180), 0, 1e-6, 'kutupta ayni nokta');
  near(initialBearingDeg(0, 0, 1, 0), 0, 1e-6, 'kuzey kerterizi');
  near(initialBearingDeg(0, 0, 0, 1), 90, 1e-6, 'dogu kerterizi');
  near(initialBearingDeg(0, 0, -1, 0), 180, 1e-6, 'guney kerterizi');
  near(initialBearingDeg(0, 0, 0, -1), 270, 1e-6, 'bati kerterizi');
  near(initialBearingDeg(0, 179.5, 0, -179.5), 90, 1e-6, 'tarih cizgisinde dogu');
  near(initialBearingDeg(0, -179.5, 0, 179.5), 270, 1e-6, 'tarih cizgisinde bati');
  undef(initialBearingDeg(20, 30, 20, 30), 'ayni noktanin kerterizi tanimsiz');
  undef(initialBearingDeg(0, 0, 0, 180), 'antipot kerteriz tanimsiz');
  undef(initialBearingDeg(90, 0, 80, 10), 'kutupta kerteriz tanimsiz');
  undef(distanceMeters(91, 0, 0, 0), 'gecersiz enlem');
  undef(distanceMeters(0, 181, 0, 0), 'gecersiz boylam');
  undef(distanceMeters(NaN, 0, 0, 0), 'NaN enlem');
  undef(distanceMeters(0, Infinity, 0, 0), 'sonsuz boylam');
  undef(initialBearingDeg(0, 0, -91, 0), 'gecersiz varis enlemi');
  near(mpsFromKnots(1), 1852 / 3600, 1e-12, '1 knot metre/saniye');
  near(knotsFromMps(1852 / 3600), 1, 1e-12, 'metre/saniye knot');
  near(knotsFromMps(0), 0, 0, 'sifir hiz');
  near(etaSeconds(12 * 1852, mpsFromKnots(6)), 2 * 3600, 1e-9, '12 mil 6 knot');
  near(etaSeconds(24 * 1852, mpsFromKnots(4)), 6 * 3600, 1e-9, '24 mil 4 knot');
  near(etaSeconds(1852, mpsFromKnots(0.5)), 2 * 3600, 1e-9, '1 mil 0,5 knot');
  near(etaSeconds(0, 0), 0, 0, 'sifir mesafe');
  undef(etaSeconds(1852, 0), 'duruyorken varis saati uydurulmaz');
  undef(etaSeconds(1852, -1), 'negatif hiz');
  undef(etaSeconds(-1, 2), 'negatif mesafe');
  undef(etaSeconds(NaN, 2), 'NaN mesafe');
  undef(etaSeconds(1852, NaN), 'NaN hiz');
  undef(etaSeconds(Infinity, 1), 'sonsuz mesafe');
  undef(mpsFromKnots(-1), 'negatif knot');
  undef(knotsFromMps(-1), 'negatif metre/saniye');
  undef(knotsFromMps(Infinity), 'sonsuz metre/saniye');

  let propertyFailures = 0;
  for (let i = 0; i < 500; i++) {
    const a = -80 + (i * 13.71) % 160;
    const b = -179 + (i * 27.81) % 358;
    const c = -80 + (i * 7.23 + 8) % 160;
    const d = -179 + (i * 31.17 + 9) % 358;
    const distance = distanceMeters(a, b, c, d);
    if (Math.abs(distance - distanceMeters(c, d, a, b)) > 1e-5) propertyFailures++;
    if (!(distance >= 0 && distance <= 20015087)) propertyFailures++;
    const bearing = initialBearingDeg(a, b, c, d);
    if (!(Number.isFinite(bearing) && bearing >= 0 && bearing < 360)) propertyFailures++;
    const knots = 0.5 + i / 10;
    if (Math.abs(knotsFromMps(mpsFromKnots(knots)) - knots) > 1e-12) propertyFailures++;
    if (Math.abs(etaSeconds(distance, mpsFromKnots(knots)) - distance / 1852 / knots * 3600) > 1e-6) propertyFailures++;
  }
  check.equal(propertyFailures, 0, '500 nokta ciftinde simetri, aralik ve birim ozellikleri');
}

async function marineGrid(check) {
  let encodingFailures = 0;
  let encodings = 0;
  for (const little of [true, false]) {
    for (const compressed of [false, true]) {
      for (const pixelPoint of [false, true]) {
        for (const matrix of [false, true]) {
          for (const signed of [false, true]) {
            encodings++;
            const bytes = await tiffFixture({ little, compressed, pixelPoint, matrix, signed });
            let raster;
            try {
              raster = await readGeoTIFF(bytes);
            } catch (error) {
              encodingFailures++;
              continue;
            }
            const west = pixelPoint ? 26.995 : 27, north = pixelPoint ? 37.005 : 37;
            const problems = [
              raster.rows === 2 && raster.columns === 3,
              Math.abs(raster.west - west) < 1e-10,
              Math.abs(raster.north - north) < 1e-10,
              raster.values[0] === -10 && raster.values[2] === 3 && Number.isNaN(raster.values[4]),
              // Half-cell inset avoids floating-point edge ambiguity in this test.
              minDepth(raster, raster.west + 0.002, raster.north - 0.008, raster.west + 0.018, raster.north - 0.002) === 10,
              minDepth(raster, raster.west + 0.022, raster.north - 0.008, raster.west + 0.028, raster.north - 0.002) === -3,
              Number.isNaN(minDepth(raster, raster.west + 0.012, raster.north - 0.018, raster.west + 0.018, raster.north - 0.012)),
              Number.isNaN(minDepth(raster, raster.west - 0.1, raster.north - 0.02, raster.west + 0.02, raster.north)),
            ];
            if (problems.some(ok => !ok)) encodingFailures++;
          }
        }
      }
    }
  }
  check.equal(encodings, 32, '32 GeoTIFF kodlama varyasyonu uretildi');
  check.equal(encodingFailures, 0, 'her kodlama dogru okundu ve dogru en sig derinligi verdi');

  const good = await tiffFixture({ matrix: true });
  let truncationAccepted = 0;
  for (let n = 0; n < good.length; n++) {
    if (!(await fails(good.subarray(0, n)))) truncationAccepted++;
  }
  check.equal(truncationAccepted, 0, `${good.length} kesilmis dosyanin tamami reddedildi`);
  check.ok(await fails(new TextEncoder().encode('<ServiceException>error')), 'XML hata sayfasi derinlik sanilmadi');

  // Deflate blocks whose declared length runs past the end of the zlib stream:
  // zlib's uncompress() decodes them, so this reader must decode them too.
  let padFailures = 0;
  for (const pad of [1, 4, 16]) {
    const padded = await tiffFixture({ compressed: true, pad });
    try {
      const raster = await readGeoTIFF(padded);
      if (!(raster.rows === 2 && raster.columns === 3 && raster.values[0] === -10)) padFailures++;
    } catch { padFailures++; }
  }
  check.equal(padFailures, 0, 'bildirilen uzunlugu asan Deflate bloklari yine de okundu');

  // Every decompression failure must arrive as GeoTIFFError(12), like the C's
  // uncompress() != Z_OK — not as an unclassified runtime error.
  const corrupt = await tiffFixture({ compressed: true });
  corrupt[corrupt.length - 6] ^= 0xff;
  corrupt[corrupt.length - 7] ^= 0xff;
  let corruptCode = null;
  try { await readGeoTIFF(corrupt); } catch (error) { corruptCode = error?.code ?? `siniflandirilmamis: ${error}`; }
  check.equal(corruptCode, 12, 'bozuk Deflate blogu GeoTIFF 12 olarak bildirildi');

  let seed = 15;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let fuzzAccepted = 0;
  for (let i = 0; i < 1000; i++) {
    const length = 8 + Math.floor(random() * 492);
    const bytes = new Uint8Array(length);
    for (let k = 0; k < length; k++) bytes[k] = Math.floor(random() * 256);
    if (!(await fails(bytes))) fuzzAccepted++;
  }
  check.equal(fuzzAccepted, 0, '1000 rastgele bayt dizisinin tamami reddedildi');

  const rows = 30, cols = 30, cell = 10;
  const mask = new Uint8Array(rows * cols);
  const at = (x, y) => cellIndex(rows, cols, cell, x, y);

  // Counter-clockwise island: land left. All horizontal rows outside its
  // latitude range must remain sea through component propagation.
  const island = [100, 100, 200, 100, 200, 200, 100, 200, 100, 100];
  const segments = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    segments[i * 4] = island[i * 2]; segments[i * 4 + 1] = island[i * 2 + 1];
    segments[i * 4 + 2] = island[i * 2 + 2]; segments[i * 4 + 3] = island[i * 2 + 3];
  }
  check.equal(coastMask(rows, cols, cell, segments, 4, mask), 0, 'ada kiyi maskesi olustu');
  check.equal(mask[at(150, 150)], 2, 'ada ici kara');
  let seaFailures = 0;
  for (const [x, y] of [[15, 15], [285, 285], [15, 150], [285, 150], [150, 15], [150, 285]]) {
    if (mask[at(x, y)] !== 1) seaFailures++;
  }
  check.equal(seaFailures, 0, 'adanin disindaki alan denizi kaldi');
  check.equal(mask[at(105, 105)], 4, 'kiyi cizgisine degen hucre blokli');

  // Open north-going mainland coast through both bbox edges: west land, east sea.
  const mainland = Float64Array.from([150, -100, 150, 400]);
  check.equal(coastMask(rows, cols, cell, mainland, 1, mask), 0, 'anakara kiyi maskesi olustu');
  check.equal(mask[at(50, 150)], 2, 'kiyinin batisi kara');
  check.equal(mask[at(250, 150)], 1, 'kiyinin dogusu deniz');

  // Two coastlines crossing a scanline at exactly the same x (a coast that
  // touches a point and returns) must cancel, not flip the whole row. The C's
  // qsort leaves their order unspecified, so this must not depend on it.
  const touching = Float64Array.from([
    150, -100, 150, 400,   // kuzeye
    150, 400, 150, -100,   // ayni cizgi, guneye
  ]);
  check.equal(coastMask(rows, cols, cell, touching, 2, mask), 0, 'degen kiyi maskesi olustu');
  check.equal(mask[at(50, 150)], mask[at(250, 150)], 'birbirini goturen kesisim ciftinde satir donmedi');

  // Tiny island entirely within a cell cannot disappear through centre sampling.
  coastMask(rows, cols, cell, mainland, 1, mask);
  blockShape(rows, cols, cell, Float64Array.from([201, 201, 203, 201, 203, 203, 201, 203, 201, 201]), 5, true, mask);
  check.equal(mask[at(205, 205)], 4, 'bir hucreden kucuk adacik yok olmadi');

  // Polygon interior, and a thin pier between centres, are blocked too.
  blockShape(rows, cols, cell, Float64Array.from([210, 40, 270, 40, 270, 90, 210, 90]), 4, true, mask);
  check.equal(mask[at(245, 65)], 4, 'poligon ici blokli');
  blockShape(rows, cols, cell, Float64Array.from([260, 100, 260, 200]), 2, false, mask);
  check.ok(mask[at(255, 155)] === 4 && mask[at(265, 155)] === 4, 'ince iskele iki yanindaki hucreleri blokluyor');
}

function autoRouter(check) {
  const SIDE = 7, CELLS = SIDE * SIDE;
  const depths = new Float64Array(CELLS);
  const uncertainty = new Float64Array(CELLS);
  const flags = new Uint8Array(CELLS);
  const grid = { rows: SIDE, columns: SIDE, cellSizeM: 10, chartedDepthM: depths, depthUncertaintyM: uncertainty, flags };
  let boat;

  const reset = () => {
    depths.fill(10); uncertainty.fill(0); flags.fill(COVERED);
    boat = { draftM: 1, underKeelClearanceM: 0.5, dynamicAllowanceM: 0, waterLevelLowerM: 0, horizontalBufferM: 0 };
  };
  const run = (start, goal, capacity) => plan(grid, boat, start, goal, { capacity });
  const status = (result, expected, label) => {
    check.equal(result.status, expected, label);
    if (expected !== DR_OK) check.ok(Number.isNaN(result.distanceM), `${label}: mesafe verilmedi`);
  };
  const near = (a, b, label) => check.close(a, b, 1e-7, label);

  reset();
  const straight = run(21, 27);
  status(straight, DR_OK, 'duz gecis bulundu');
  near(straight.distanceM, 60, 'duz gecis mesafesi');
  check.ok(straight.path[0] === 21 && straight.path[straight.count - 1] === 27, 'uclar korundu');
  near(etaSeconds(straight.distanceM, mpsFromKnots(6)), 60 / 1852 / 6 * 3600, 'gecis suresi');

  flags[24] = COVERED | LAND;
  const detour = run(21, 27);
  status(detour, DR_OK, 'engel etrafindan gecis bulundu');
  check.ok(detour.distanceM > straight.distanceM, 'dolasma daha uzun');
  check.ok(!Array.from(detour.path).includes(24), 'engel hucresi kullanilmadi');

  // The shallow passage closes as draft, uncertainty or allowance increase.
  reset();
  for (let r = 0; r < SIDE - 1; r++) depths[r * SIDE + 3] = 2;
  const shallowBoat = run(21, 27);
  status(shallowBoat, DR_OK, 'sig gecis kucuk tekneye acik');
  near(shallowBoat.distanceM, 60, 'sig gecis mesafesi');
  boat.draftM = 2;
  const deepBoat = run(21, 27);
  status(deepBoat, DR_OK, 'derin tekne dolasiyor');
  check.ok(deepBoat.distanceM > shallowBoat.distanceM, 'derin tekne icin yol uzadi');
  boat.waterLevelLowerM = 1;
  status(run(21, 27), DR_OK, 'yuksek su seviyesinde gecis acik');
  near(run(21, 27).distanceM, 60, 'yuksek su seviyesi mesafesi');
  boat = { draftM: 1, underKeelClearanceM: 0.5, dynamicAllowanceM: 0, waterLevelLowerM: -1, horizontalBufferM: 0 };
  near(run(21, 27).distanceM, deepBoat.distanceM, 'su seviyesi dususu gecisi kapatir');
  boat = { draftM: 1, underKeelClearanceM: 0.5, dynamicAllowanceM: 1, waterLevelLowerM: 0, horizontalBufferM: 0 };
  near(run(21, 27).distanceM, deepBoat.distanceM, 'model payi gecisi kapatir');
  boat.dynamicAllowanceM = 0;
  for (let r = 0; r < SIDE - 1; r++) uncertainty[r * SIDE + 3] = 0.6;
  near(run(21, 27).distanceM, deepBoat.distanceM, 'belirsizlik gecisi kapatir');

  // Gaps and closed barriers must not cause a direct-line fallback.
  reset();
  for (let r = 0; r < SIDE; r++) flags[r * SIDE + 3] = 0;
  status(run(21, 27), DR_NO_ROUTE, 'bilinmeyen bariyerde duz cizgiye dusulmez');
  for (let r = 0; r < SIDE; r++) flags[r * SIDE + 3] = COVERED | RESTRICTED;
  status(run(21, 27), DR_NO_ROUTE, 'kisitli alan bariyeri');
  for (let r = 0; r < SIDE; r++) flags[r * SIDE + 3] = COVERED | OBSTACLE;
  status(run(21, 27), DR_NO_ROUTE, 'engel bariyeri');
  reset();
  for (let r = 0; r < SIDE; r++) depths[r * SIDE + 3] = NaN;
  status(run(21, 27), DR_NO_ROUTE, 'derinligi bilinmeyen bariyer');
  reset();
  for (let r = 0; r < SIDE; r++) uncertainty[r * SIDE + 3] = NaN;
  status(run(21, 27), DR_NO_ROUTE, 'belirsizligi bilinmeyen bariyer');
  reset();
  flags[1] = LAND; flags[SIDE] = LAND;
  status(run(0, 8), DR_NO_ROUTE, 'kose kesme yok');
  flags[0] = LAND;
  status(run(0, 8), DR_START_BLOCKED, 'baslangic kapali');
  reset(); flags[8] = LAND;
  status(run(0, 8), DR_GOAL_BLOCKED, 'varis kapali');

  // Horizontal margins include edges; endpoints are never moved silently.
  reset(); flags[24] = OBSTACLE;
  const unbuffered = run(22, 26);
  status(unbuffered, DR_OK, 'paysiz gecis');
  boat.horizontalBufferM = 10;
  const buffered = run(22, 26);
  status(buffered, DR_OK, 'payli gecis');
  check.ok(buffered.distanceM > unbuffered.distanceM, 'pay yolu uzatti');
  let bufferFailures = 0;
  for (const index of buffered.path) {
    const r = Math.floor(index / SIDE), c = index % SIDE;
    if (!(r >= 1 && c >= 1 && r < 6 && c < 6)) bufferFailures++;
    if (!(Math.abs(r - 3) > 1 || Math.abs(c - 3) > 1)) bufferFailures++;
  }
  check.equal(bufferFailures, 0, 'payli yol grid kenarindan ve engelden uzak durdu');
  status(run(21, 27), DR_START_BLOCKED, 'pay baslangici kapatirsa nokta tasinmaz');
  boat.horizontalBufferM = 100;
  status(run(22, 26), DR_START_BLOCKED, 'gridden buyuk pay');

  reset();
  status(run(24, 24), DR_OK, 'ayni hucre');
  near(run(24, 24).distanceM, 0, 'ayni hucre mesafesi sifir');
  const shortOutput = run(21, 27, 1);
  status(shortOutput, DR_OUTPUT_TOO_SMALL, 'yetersiz cikti tamponu');
  check.ok(shortOutput.count > 1 && shortOutput.path === null, 'kismi yol yazilmadi');
  boat.draftM = NaN;
  status(run(21, 27), DR_INVALID_INPUT, 'NaN su cekimi');
  reset(); boat.draftM = 0;
  status(run(21, 27), DR_INVALID_INPUT, 'sifir su cekimi');
  reset(); boat.horizontalBufferM = -1;
  status(run(21, 27), DR_INVALID_INPUT, 'negatif pay');
  reset();
  status(run(CELLS, 0), DR_INVALID_INPUT, 'grid disinda baslangic');
  status(plan({ ...grid, rows: Number.MAX_SAFE_INTEGER }, boat, 0, 1, {}), DR_INVALID_INPUT, 'imkansiz grid boyutu');

  // O(V^2) Dijkstra oracle, independent of the A* heap.
  const reference = (start, goal) => {
    if (flags[start] !== COVERED || flags[goal] !== COVERED) return Infinity;
    const distance = new Float64Array(CELLS).fill(Infinity);
    const visited = new Uint8Array(CELLS);
    distance[start] = 0;
    for (let iteration = 0; iteration < CELLS; iteration++) {
      let current = -1;
      for (let i = 0; i < CELLS; i++) if (!visited[i] && (current < 0 || distance[i] < distance[current])) current = i;
      if (current < 0 || !Number.isFinite(distance[current])) break;
      visited[current] = 1;
      for (let next = 0; next < CELLS; next++) {
        const dr = Math.abs(Math.floor(next / SIDE) - Math.floor(current / SIDE));
        const dc = Math.abs((next % SIDE) - (current % SIDE));
        if ((dr === 0 && dc === 0) || dr > 1 || dc > 1 || flags[next] !== COVERED) continue;
        if (dr && dc && (flags[Math.floor(current / SIDE) * SIDE + (next % SIDE)] !== COVERED
          || flags[Math.floor(next / SIDE) * SIDE + (current % SIDE)] !== COVERED)) continue;
        const value = distance[current] + Math.hypot(dr, dc) * grid.cellSizeM;
        if (value < distance[next]) distance[next] = value;
      }
    }
    return distance[goal];
  };

  let seed = 4179;
  let scenarioFailures = 0, noRouteScenarios = 0, routedScenarios = 0;
  for (let scenario = 0; scenario < 300; scenario++) {
    reset();
    for (let i = 0; i < CELLS; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      flags[i] = (seed >>> 16) % 100 < 30 ? LAND : COVERED;
    }
    flags[0] = COVERED; flags[CELLS - 1] = COVERED;
    const expected = reference(0, CELLS - 1);
    const result = run(0, CELLS - 1);
    if (!Number.isFinite(expected)) {
      noRouteScenarios++;
      if (result.status !== DR_NO_ROUTE) scenarioFailures++;
      continue;
    }
    routedScenarios++;
    if (result.status !== DR_OK || Math.abs(result.distanceM - expected) >= 1e-7) { scenarioFailures++; continue; }
    if (result.path[0] !== 0 || result.path[result.count - 1] !== CELLS - 1) { scenarioFailures++; continue; }
    let length = 0;
    for (let j = 0; j < result.count; j++) {
      const index = result.path[j];
      if (!(index < CELLS && flags[index] === COVERED)) { scenarioFailures++; break; }
      if (j === 0) continue;
      const r0 = Math.floor(result.path[j - 1] / SIDE), c0 = result.path[j - 1] % SIDE;
      const r1 = Math.floor(index / SIDE), c1 = index % SIDE;
      const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
      if (!(dr <= 1 && dc <= 1 && dr + dc > 0)) { scenarioFailures++; break; }
      if (dr && dc && !(flags[r0 * SIDE + c1] === COVERED && flags[r1 * SIDE + c0] === COVERED)) {
        scenarioFailures++; break;
      }
      length += Math.hypot(dr, dc) * grid.cellSizeM;
    }
    if (Math.abs(length - result.distanceM) >= 1e-7) scenarioFailures++;
  }
  check.equal(scenarioFailures, 0, `300 rastgele gridde Dijkstra ile birebir ayni sonuc (${routedScenarios} rota, ${noRouteScenarios} rotasiz)`);
  check.ok(routedScenarios > 0 && noRouteScenarios > 0, 'rastgele senaryolar hem rotali hem rotasiz durumlari kapsadi');
}

export async function run(check) {
  navigationMath(check);
  await marineGrid(check);
  autoRouter(check);
}
