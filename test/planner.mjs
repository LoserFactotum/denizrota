// "Rota bulunamadi" teshisi: varis kopuk bir cepteyse bunu ayirt edip
// ulasilabilir en yakin suyu bildirmeli. Sentetik grid; ag yok.
//
// Bu, Marmaris ic korfezi gibi durumlarin karsiligi: model girisi sig gorunce
// alani genisletmek hicbir sey degistirmez, kullaniciya ulasilabilir suyu
// gostermek gerekir.

import { METERS_PER_LATITUDE_DEGREE } from '../engine/grid.js';
import { diagnoseNoRoute } from '../engine/planner.js';
import { COVERED, LAND } from '../engine/router.js';
import { WATER, LAND as MASK_LAND } from '../engine/mask.js';

/** rows x columns su gridi; [c0,c1) sutunlari arasi sig bir bariyerle bolunur. */
function syntheticGrid({ rows = 40, columns = 60, cell = 100, barrierFrom, barrierTo, depth = 20 }) {
  const total = rows * columns;
  const depths = new Float64Array(total).fill(depth);
  const flags = new Uint8Array(total).fill(COVERED);
  const mask = new Uint8Array(total).fill(WATER);
  for (let r = 0; r < rows; r++) {
    for (let c = barrierFrom; c < barrierTo; c++) {
      const i = r * columns + c;
      depths[i] = 1;          // modelce cok sig
      flags[i] = LAND;        // gecilemez
      mask[i] = MASK_LAND;
    }
  }
  const ky = METERS_PER_LATITUDE_DEGREE;
  const bounds = {
    rows, columns, cell, west: 27, south: 36,
    metersPerLatitudeDegree: ky, metersPerLongitudeDegree: ky,
    get east() { return this.west + columns * cell / ky; },
    get north() { return this.south + rows * cell / ky; },
    get count() { return rows * columns; },
  };
  return { bounds, depths, flags, mask, total };
}

/** Hucre merkezinin koordinati (cellCentre ile ayni formul). */
function pointAt(bounds, row, col, name) {
  return {
    name,
    latitude: bounds.south + (bounds.rows - 1 - row + 0.5) * bounds.cell / bounds.metersPerLatitudeDegree,
    longitude: bounds.west + (col + 0.5) * bounds.cell / bounds.metersPerLongitudeDegree,
  };
}

export async function run(check) {
  const boat = { draft: 1.5, underKeel: 1, modelAllowance: 5, waterLevelDrop: 0, horizontalBuffer: 0 };

  // --- kopuk cep: sag tarafta dar bir alan, aradaki sutunlar gecilemez
  const grid = syntheticGrid({ barrierFrom: 50, barrierTo: 53 });
  const from = pointAt(grid.bounds, 20, 5, 'Baslangic');
  const to = pointAt(grid.bounds, 20, 57, 'Varis');

  const isolated = diagnoseNoRoute({ grid, boat, from, to });
  check.ok(isolated !== null, 'kopuk cep teshis edildi');
  check.equal(isolated.reason, 'isolated', 'sebep: kopuk cep');
  check.ok(isolated.reachableCells > isolated.pocketCells, 'ulasilabilir alan cepten buyuk');
  check.equal(isolated.reachableCells, 40 * 50, 'bariyerin solundaki tum hucreler ulasilabilir');
  check.equal(isolated.pocketCells, 40 * 7, 'cep, bariyerin sagindaki hucreler');
  check.ok(isolated.nearest !== null, 'ulasilabilir en yakin su bildirildi');

  // En yakin nokta, cebin degil BASLANGICIN tarafinda olmali.
  const nearestCol = Math.round(
    (isolated.nearest.longitude - grid.bounds.west) * grid.bounds.metersPerLongitudeDegree / grid.bounds.cell - 0.5);
  check.ok(nearestCol < 50, 'onerilen nokta bariyerin baslangic tarafinda');
  check.equal(nearestCol, 49, 'onerilen nokta bariyerin hemen dibindeki son gecilebilir sutun');
  check.close(isolated.nearest.distanceM, 8 * grid.bounds.cell, 1, 'uzaklik hucre sayisiyla tutarli');
  check.ok(Number.isFinite(isolated.nearest.bearingDeg), 'kerteriz hesaplandi');
  check.equal(isolated.cellM, 100, 'hucre boyutu bildirildi');
  check.equal(isolated.requiredDepth, 7.5, 'gereken derinlik bildirildi');

  // --- ulasilabilir varis: teshis null donmeli (sorun baska yerde)
  const open = syntheticGrid({ barrierFrom: 50, barrierTo: 50 }); // bariyer yok
  check.equal(
    diagnoseNoRoute({ grid: open, boat, from: pointAt(open.bounds, 20, 5, 'A'), to: pointAt(open.bounds, 20, 57, 'B') }),
    null, 'varis ulasilabilirse kopuk cep teshisi verilmez');

  // --- grid disindaki nokta teshisi cokertmemeli
  check.equal(
    diagnoseNoRoute({ grid, boat, from, to: { name: 'Uzak', latitude: 40, longitude: 40 } }),
    null, 'grid disindaki varis icin guvenle null');

  // --- fiili pay bildirimi: ceil(pay/hucre)*hucre
  const buffered = { ...boat, horizontalBuffer: 150 };
  const withBuffer = diagnoseNoRoute({ grid, boat: buffered, from, to });
  check.ok(withBuffer !== null, 'payli durumda da teshis edildi');
  check.equal(withBuffer.effectiveBufferM, 200, '150 m istek, 100 m hucrede fiilen 200 m');
  check.ok(withBuffer.effectiveBufferM > withBuffer.bufferM, 'fiili pay istekten buyuk oldugu bildiriliyor');
}
