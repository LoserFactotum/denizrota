// Port of ios/DenizRota/Core/AutoRouter.c — dr_plan.
//
// A* on 8-connected cells, no diagonal corner cutting. A positive horizontal
// buffer conservatively expands blocked areas by a square of ceil(buffer/cell)
// cells. Out-of-coverage is blocked. Never snaps endpoints, fills data gaps,
// relaxes clearance, or returns a straight-line fallback on failure.

export const COVERED = 1, LAND = 2, OBSTACLE = 4, RESTRICTED = 8;

export const DR_OK = 0, DR_INVALID_INPUT = 1, DR_NO_MEMORY = 2, DR_START_BLOCKED = 3,
  DR_GOAL_BLOCKED = 4, DR_NO_ROUTE = 5, DR_OUTPUT_TOO_SMALL = 6, DR_CANCELLED = 7;

const NONE = -1;

function nonnegative(value) { return Number.isFinite(value) && value >= 0; }

/**
 * Cells a vessel may occupy: covered, deep enough, and with every cell inside
 * the horizontal buffer equally clear. Grid edges within the buffer are closed.
 * Shared by plan() and by the blocked-endpoint diagnosis, so both agree exactly.
 */
export function passableCells(grid, vessel) {
  const rows = grid.rows, columns = grid.columns;
  const required = vessel.draftM + vessel.underKeelClearanceM + vessel.dynamicAllowanceM;
  const radius = Math.ceil(vessel.horizontalBufferM / grid.cellSizeM);
  const stride = columns + 1;
  const prefix = new Uint32Array((rows + 1) * stride);
  const pass = new Uint8Array(rows * columns);
  const depths = grid.chartedDepthM, uncertainties = grid.depthUncertaintyM, flags = grid.flags;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const depth = depths[i], uncertainty = uncertainties[i];
      const available = depth + vessel.waterLevelLowerM - uncertainty;
      const valid = flags[i] === COVERED && Number.isFinite(depth)
        && nonnegative(uncertainty) && Number.isFinite(available) && available >= required;
      prefix[(r + 1) * stride + c + 1] = (valid ? 0 : 1)
        + prefix[r * stride + c + 1] + prefix[(r + 1) * stride + c] - prefix[r * stride + c];
    }
  }
  if (radius >= rows || radius >= columns) return { pass, radius, required, prefix, stride, tooLarge: true };
  for (let r = radius; r + radius < rows; r++) {
    const r0 = r - radius, r1 = r + radius + 1;
    for (let c = radius; c + radius < columns; c++) {
      const c0 = c - radius, c1 = c + radius + 1;
      const blocked = prefix[r1 * stride + c1] - prefix[r0 * stride + c1]
        - prefix[r1 * stride + c0] + prefix[r0 * stride + c0];
      pass[r * columns + c] = blocked === 0 ? 1 : 0;
    }
  }
  return { pass, radius, required, prefix, stride, tooLarge: false };
}

/**
 * @param grid   {rows, columns, cellSizeM, chartedDepthM, depthUncertaintyM, flags}
 * @param vessel {draftM, underKeelClearanceM, dynamicAllowanceM, waterLevelLowerM, horizontalBufferM}
 * @param opts   {maxCells, shouldCancel, capacity}
 * @returns {status, count, distanceM, path} — path is null unless status is DR_OK.
 *          With opts.capacity set, an overlong path reports DR_OUTPUT_TOO_SMALL
 *          and the needed length in count, writing no partial path.
 */
export function plan(grid, vessel, start, goal, opts = {}) {
  const maxCells = opts.maxCells ?? 1000000;
  const shouldCancel = opts.shouldCancel;
  const capacity = opts.capacity;
  const fail = (status) => ({ status, count: 0, distanceM: NaN, path: null });

  if (!grid || !vessel || !grid.rows || !grid.columns
    || grid.rows > maxCells || grid.columns > Math.floor(maxCells / grid.rows)
    || !Number.isFinite(grid.cellSizeM) || grid.cellSizeM <= 0 || grid.cellSizeM > 1000000
    || !grid.chartedDepthM || !grid.depthUncertaintyM || !grid.flags
    || !Number.isFinite(vessel.draftM) || vessel.draftM <= 0
    || !nonnegative(vessel.underKeelClearanceM)
    || !nonnegative(vessel.dynamicAllowanceM)
    || !nonnegative(vessel.horizontalBufferM)
    || !Number.isFinite(vessel.waterLevelLowerM)) return fail(DR_INVALID_INPUT);

  const rows = grid.rows, columns = grid.columns, count = rows * columns;
  if (start >= count || goal >= count || start < 0 || goal < 0) return fail(DR_INVALID_INPUT);

  const required = vessel.draftM + vessel.underKeelClearanceM + vessel.dynamicAllowanceM;
  const radiusValue = Math.ceil(vessel.horizontalBufferM / grid.cellSizeM);
  if (!Number.isFinite(required) || !Number.isFinite(radiusValue)) return fail(DR_INVALID_INPUT);
  if (radiusValue >= rows || radiusValue >= columns) return fail(DR_START_BLOCKED);

  const closed = new Uint8Array(count);
  const cost = new Float64Array(count).fill(Infinity);
  const priority = new Float64Array(count).fill(Infinity);
  const parents = new Int32Array(count).fill(NONE);
  const nodes = new Int32Array(count);
  const positions = new Int32Array(count).fill(NONE);

  const { pass } = passableCells(grid, vessel);
  if (!pass[start]) return fail(DR_START_BLOCKED);
  if (!pass[goal]) return fail(DR_GOAL_BLOCKED);

  let heapCount = 0;
  const less = (a, b) => priority[a] < priority[b] || (priority[a] === priority[b] && a < b);
  const swap = (a, b) => {
    const t = nodes[a]; nodes[a] = nodes[b]; nodes[b] = t;
    positions[nodes[a]] = a; positions[nodes[b]] = b;
  };
  const decrease = (node) => {
    let at = positions[node];
    if (at === NONE) { at = heapCount++; nodes[at] = node; positions[node] = at; }
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!less(nodes[at], nodes[parent])) break;
      swap(at, parent); at = parent;
    }
  };
  const pop = () => {
    const result = nodes[0];
    positions[result] = NONE;
    heapCount--;
    if (heapCount > 0) {
      nodes[0] = nodes[heapCount];
      positions[nodes[0]] = 0;
      let at = 0;
      while (at * 2 + 1 < heapCount) {
        let child = at * 2 + 1;
        if (child + 1 < heapCount && less(nodes[child + 1], nodes[child])) child++;
        if (!less(nodes[child], nodes[at])) break;
        swap(child, at); at = child;
      }
    }
    return result;
  };

  const goalRow = Math.floor(goal / columns), goalCol = goal % columns;
  const heuristic = (node) => Math.hypot(Math.floor(node / columns) - goalRow, (node % columns) - goalCol);

  const SQRT2 = Math.sqrt(2.0);
  cost[start] = 0;
  priority[start] = heuristic(start);
  decrease(start);
  let expansions = 0;
  while (heapCount > 0) {
    const current = pop();
    if (current === goal) {
      let length = 1;
      for (let at = goal; at !== start; at = parents[at]) length++;
      if (capacity !== undefined && length > capacity) {
        return { status: DR_OUTPUT_TOO_SMALL, count: length, distanceM: NaN, path: null };
      }
      const path = new Int32Array(length);
      let at = goal;
      for (let j = length; j > 0; j--) { path[j - 1] = at; at = parents[at]; }
      return { status: DR_OK, count: length, distanceM: cost[goal] * grid.cellSizeM, path };
    }
    if (shouldCancel && (++expansions & 0xffff) === 0 && shouldCancel()) return fail(DR_CANCELLED);
    closed[current] = 1;
    const row = Math.floor(current / columns), column = current - row * columns;
    for (let dy = -1; dy <= 1; dy++) {
      const nr = row + dy;
      if (nr < 0 || nr >= rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nc = column + dx;
        if (nc < 0 || nc >= columns) continue;
        const next = nr * columns + nc;
        if (!pass[next] || closed[next]) continue;
        if (dx && dy && (!pass[row * columns + nc] || !pass[nr * columns + column])) continue;
        const tentative = cost[current] + (dx && dy ? SQRT2 : 1.0);
        if (tentative < cost[next]) {
          cost[next] = tentative; parents[next] = current;
          priority[next] = tentative + heuristic(next);
          decrease(next);
        }
      }
    }
  }
  return fail(DR_NO_ROUTE);
}
