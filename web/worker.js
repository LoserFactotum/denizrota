// Hesap arka planda calisir; arayuz hicbir zaman donmaz.
// Sonuc olarak yalnizca gerekli diziler ana ipe aktarilir (transferable).

import { planRoute } from './engine/planner.js';
import { passableCells } from './engine/router.js';
import { SourceCache } from './cache.js';

const cache = new SourceCache();
let controller = null;

function serialiseBounds(bounds) {
  return {
    cell: bounds.cell, margin: bounds.margin,
    west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north,
    rows: bounds.rows, columns: bounds.columns,
    metersPerLatitudeDegree: bounds.metersPerLatitudeDegree,
    metersPerLongitudeDegree: bounds.metersPerLongitudeDegree,
  };
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'cancel') {
    controller?.abort();
    return;
  }

  if (message.type !== 'plan') return;
  controller = new AbortController();
  try {
    const route = await planRoute({
      anchors: message.anchors,
      boat: message.boat,
      cache,
      signal: controller.signal,
      cellOverride: message.cellOverride,
      maxCells: message.maxCells,
      enforceOwnWaters: message.enforceOwnWaters !== false,
      onProgress: (text, fraction) => self.postMessage({ type: 'progress', text, fraction }),
    });

    const grid = route.grid;
    const bounds = route.bounds;
    // Guvenlik karari tam hassasiyetle burada verilir; ana ipe yalnizca sonucu gider.
    const { pass } = passableCells({
      rows: bounds.rows, columns: bounds.columns, cellSizeM: bounds.cell,
      chartedDepthM: grid.depths,
      depthUncertaintyM: new Float64Array(grid.total),
      flags: grid.flags,
    }, {
      draftM: route.boat.draft,
      underKeelClearanceM: route.boat.underKeel,
      dynamicAllowanceM: route.boat.modelAllowance,
      waterLevelLowerM: -route.boat.waterLevelDrop,
      horizontalBufferM: route.boat.horizontalBuffer,
    });

    // Derinlik yalnizca gosterim icin; karar zaten pass/mask icinde.
    const displayDepths = new Float32Array(grid.total);
    for (let i = 0; i < grid.total; i++) displayDepths[i] = grid.depths[i];

    const payload = {
      type: 'done',
      points: route.points,
      anchors: route.anchors,
      legs: route.legs,
      boat: route.boat,
      minimumDepth: route.minimumDepth,
      distanceM: route.distanceM,
      gridDistanceM: route.gridDistanceM,
      shallowestModelDepth: route.shallowestModelDepth,
      pathCellCount: route.cells.length,
      provenance: route.provenance,
      bounds: serialiseBounds(bounds),
      mask: grid.mask,
      pass,
      depths: displayDepths,
      boundaryLines: grid.boundaryLines ?? [],
      foreignCellCount: grid.foreign ?? 0,
      boundaryChecked: grid.boundaryChecked ?? false,
    };
    self.postMessage(payload, [grid.mask.buffer, pass.buffer, displayDepths.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error?.message ?? String(error),
      detail: error?.detail ?? null,
      aborted: controller?.signal.aborted === true,
    });
  } finally {
    controller = null;
  }
};
