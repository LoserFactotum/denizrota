// Port of ios/DenizRota/Core/MarineGrid.c — dm_block_shape, dm_coast_mask,
// dm_cell_index. Metric local plane; origin is the grid's south-west corner,
// row 0 is north. Coastlines are directed with land on the left (OSM rule).
// Mask values: 0 unknown, 1 water, 2 land, 4 coast/obstacle.
//
// Points are packed as Float64Array [x0,y0,x1,y1,...]; coast segments as
// [ax,ay,bx,by,...]. Results are identical to the C original; the row-band
// index below only skips segments that could not cross the scanline anyway.

export const UNKNOWN = 0, WATER = 1, LAND = 2, BLOCKED = 4;

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  // C's fmax/fmin discard a NaN operand and return the other one, so the C
  // clamps a NaN t to 1 and still measures a real distance. JS Math.min/max
  // propagate NaN, which would make `distance <= pad` false and leave a cell
  // the C blocks unblocked — the unsafe direction. Match the C.
  t = Number.isNaN(t) ? 1 : Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function insidePolygon(px, py, points, count) {
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const iy = points[i * 2 + 1], jy = points[j * 2 + 1];
    if ((iy > py) !== (jy > py)
      && px < (points[j * 2] - points[i * 2]) * (py - iy) / (jy - iy) + points[i * 2]) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Paint cells touched by a polyline (fill=false) or polygon (fill=true) as
 * BLOCKED. Sub-cell geometry is rasterised with the cell half-diagonal, so a
 * rock narrower than one cell still blocks the cell it sits in.
 */
export function blockShape(rows, cols, cell, points, count, fill, mask) {
  if (!points || !count || !mask || !rows || !cols || !Number.isFinite(cell) || cell <= 0) return;
  let w = points[0], e = w, s = points[1], n = s;
  for (let i = 0; i < count; i++) {
    const x = points[i * 2], y = points[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < w) w = x; if (x > e) e = x;
    if (y < s) s = y; if (y > n) n = y;
  }
  const pad = cell * 0.707106782;
  if (e + pad < 0 || w - pad > cols * cell || n + pad < 0 || s - pad > rows * cell) return;
  const x0 = Math.max(0, Math.floor((w - pad) / cell)), x1 = Math.min(cols, Math.ceil((e + pad) / cell));
  const y0 = Math.max(0, Math.floor((s - pad) / cell)), y1 = Math.min(rows, Math.ceil((n + pad) / cell));
  for (let y = y0; y < y1; y++) {
    const qy = (y + 0.5) * cell;
    const rowBase = (rows - 1 - y) * cols;
    for (let x = x0; x < x1; x++) {
      const qx = (x + 0.5) * cell;
      let blocked = fill && count >= 3 && insidePolygon(qx, qy, points, count);
      if (count === 1) blocked = Math.hypot(qx - points[0], qy - points[1]) <= pad;
      for (let i = 1; !blocked && i < count; i++) {
        blocked = segmentDistance(qx, qy, points[(i - 1) * 2], points[(i - 1) * 2 + 1],
          points[i * 2], points[i * 2 + 1]) <= pad;
      }
      if (fill && !blocked && count >= 3) {
        blocked = segmentDistance(qx, qy, points[(count - 1) * 2], points[(count - 1) * 2 + 1],
          points[0], points[1]) <= pad;
      }
      if (blocked) mask[rowBase + x] = BLOCKED;
    }
  }
}

/**
 * Build the land/water mask from directed OSM coastlines.
 * Returns 0 on success, nonzero on invalid input — same codes as the C original.
 * Contradictory or seedless components stay UNKNOWN and are never routed through.
 */
export function coastMask(rows, cols, cell, coast, count, mask, maxCells = 1000000) {
  if (!rows || !cols || rows > Math.floor(maxCells / cols) || !count || count > 300000
    || !coast || !mask || !Number.isFinite(cell) || cell <= 0) return 1;
  const total = rows * cols;
  mask.fill(0);

  const segment = new Float64Array(4);
  for (let i = 0; i < count; i++) {
    const ax = coast[i * 4], ay = coast[i * 4 + 1], bx = coast[i * 4 + 2], by = coast[i * 4 + 3];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return 1;
    segment[0] = ax; segment[1] = ay; segment[2] = bx; segment[3] = by;
    blockShape(rows, cols, cell, segment, 2, false, mask);
  }

  // Row bands: a segment can only cross scanlines inside its own y-range.
  const BAND = 32;
  const bandCount = Math.ceil(rows / BAND);
  const bands = new Array(bandCount);
  for (let b = 0; b < bandCount; b++) bands[b] = [];
  for (let i = 0; i < count; i++) {
    const ay = coast[i * 4 + 1], by = coast[i * 4 + 3];
    const ymin = Math.min(ay, by), ymax = Math.max(ay, by);
    // Scanline of row r is y = (rows - r - 0.5) * cell, decreasing with r.
    // One row of slack on each side keeps float edges out of the fast path.
    let firstRow = Math.floor(rows - 0.5 - ymax / cell) - 1;
    let lastRow = Math.ceil(rows - 0.5 - ymin / cell) + 1;
    if (lastRow < 0 || firstRow > rows - 1) continue;
    if (firstRow < 0) firstRow = 0;
    if (lastRow > rows - 1) lastRow = rows - 1;
    for (let b = Math.floor(firstRow / BAND); b <= Math.floor(lastRow / BAND); b++) bands[b].push(i);
  }

  const crossX = new Float64Array(count);
  const crossNorth = new Uint8Array(count);
  const order = new Int32Array(count);
  for (let row = 0; row < rows; row++) {
    const y = (rows - row - 0.5) * cell;
    const candidates = bands[Math.floor(row / BAND)];
    let c = 0;
    for (let k = 0; k < candidates.length; k++) {
      const i = candidates[k];
      const ax = coast[i * 4], ay = coast[i * 4 + 1], bx = coast[i * 4 + 2], by = coast[i * 4 + 3];
      if ((ay > y) !== (by > y)) {
        crossX[c] = ax + (y - ay) * (bx - ax) / (by - ay);
        crossNorth[c] = by > ay ? 1 : 0;
        c++;
      }
    }
    if (!c) continue;
    for (let k = 0; k < c; k++) order[k] = k;
    const slice = order.subarray(0, c);
    slice.sort((a, b) => (crossX[a] - crossX[b]) || (a - b));
    let next = 0;
    let label = crossNorth[slice[0]] ? LAND : WATER;
    let ambiguous = false;
    const rowBase = row * cols;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cell;
      while (next < c && crossX[slice[next]] < x) {
        // Crossings at the SAME x are consumed as one run. Taking them one by
        // one would make the label for the rest of the row depend on their sort
        // order — and the C's qsort leaves that order unspecified. A run that
        // cancels (equal numbers each way, a coastline touching a point and
        // returning) leaves the side unchanged; a run all one way sets it; a
        // run that is genuinely lopsided is order-dependent, so the rest of the
        // row is left UNKNOWN rather than guessed.
        let end = next + 1;
        while (end < c && crossX[slice[end]] === crossX[slice[next]]) end++;
        if (end - next === 1) {
          label = crossNorth[slice[next]] ? WATER : LAND;
        } else {
          let north = 0;
          for (let k = next; k < end; k++) north += crossNorth[slice[k]];
          const south = (end - next) - north;
          if (north === south) { /* cancels: side unchanged */ }
          else if (north === 0 || south === 0) label = crossNorth[slice[next]] ? WATER : LAND;
          else ambiguous = true;
        }
        next = end;
      }
      // Inconsistent adjacent orientations imply incomplete/broken geometry.
      const valid = !ambiguous
        && (next === 0 || next === c || crossNorth[slice[next - 1]] !== crossNorth[slice[next]]);
      if (mask[rowBase + col] !== BLOCKED) mask[rowBase + col] = valid ? label : UNKNOWN;
    }
  }

  // Fill rows without crossings, while detecting contradictory components.
  // A coast barrier prevents sea and land from sharing a component.
  const queue = new Int32Array(total);
  const visited = new Uint8Array(total);
  for (let seed = 0; seed < total; seed++) {
    if (visited[seed] || mask[seed] === BLOCKED) continue;
    let head = 0, tail = 1;
    queue[0] = seed; visited[seed] = 1;
    let bits = 0;
    while (head < tail) {
      const i = queue[head++];
      const r = Math.floor(i / cols), col = i - r * cols;
      bits |= mask[i];
      if (r > 0) { const j = i - cols; if (!visited[j] && mask[j] !== BLOCKED) { visited[j] = 1; queue[tail++] = j; } }
      if (r + 1 < rows) { const j = i + cols; if (!visited[j] && mask[j] !== BLOCKED) { visited[j] = 1; queue[tail++] = j; } }
      if (col > 0) { const j = i - 1; if (!visited[j] && mask[j] !== BLOCKED) { visited[j] = 1; queue[tail++] = j; } }
      if (col + 1 < cols) { const j = i + 1; if (!visited[j] && mask[j] !== BLOCKED) { visited[j] = 1; queue[tail++] = j; } }
    }
    const value = bits === WATER ? WATER : bits === LAND ? LAND : UNKNOWN;
    for (let i = 0; i < tail; i++) mask[queue[i]] = value;
  }
  return 0;
}

/** Cell index for a metric point, or -1 when it falls outside the grid. Clamps nothing. */
export function cellIndex(rows, cols, cell, x, y) {
  if (!rows || !cols || !Number.isFinite(cell) || cell <= 0 || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= cols * cell || y >= rows * cell) return -1;
  return (rows - 1 - Math.floor(y / cell)) * cols + Math.floor(x / cell);
}

/**
 * Every cell a straight segment between two cell centres touches — the
 * "supercover" of the line, not just Bresenham's thin line. Where the segment
 * passes exactly through a corner both flanking cells are visited, matching the
 * router's rule that a diagonal step needs both its side cells open.
 *
 * visit(row, col) may return false to stop early; lineCells then returns false.
 * Used to prove a smoothed leg is safe: if every cell it touches is passable,
 * the straight line is at least as good as the staircase it replaces.
 */
export function lineCells(r0, c0, r1, c1, visit) {
  let x = c0, y = r0;
  let dx = Math.abs(c1 - c0), dy = Math.abs(r1 - r0);
  const xInc = c1 > c0 ? 1 : -1;
  const yInc = r1 > r0 ? 1 : -1;
  let n = 1 + dx + dy;
  let error = dx - dy;
  dx *= 2; dy *= 2;
  for (; n > 0; n--) {
    if (visit(y, x) === false) return false;
    if (error > 0) { x += xInc; error -= dy; }
    else if (error < 0) { y += yInc; error += dx; }
    else {
      // Exactly through a corner: both side cells must be open too.
      if (visit(y, x + xInc) === false) return false;
      if (visit(y + yInc, x) === false) return false;
      x += xInc; y += yInc;
      error -= dy; error += dx;
      n--;
    }
  }
  return true;
}
