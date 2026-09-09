import io

p = 'engine/planner.js'
s = io.open(p, encoding='utf-8').read()

def rep(old, new):
    global s
    assert old in s, old[:80]
    s = s.replace(old, new, 1)

# --- yeni teshis: varis kucuk, kopuk bir cepte mi? -------------------------
rep("""/** Keep direction changes and at least every 8th cell; never cut a corner. */""",
"""/**
 * "Rota bulunamadi" durumunu ayristirir.
 *
 * Iki cok farkli sebep ayni hataya cikiyordu: (a) arama alani dar kalmis,
 * (b) varis, deniz yoluyla ulasilamayan kucuk bir cebin icinde — Marmaris ic
 * korfezi gibi, girisini model sig gorduğu icin. Ikincisinde alani genisletmek
 * hicbir sey degistirmez; kullaniciya ulasilabilir en yakin suyu gostermek ve
 * dilerse dogrulanmamis etapla baglamasini onermek gerekir.
 */
export function diagnoseNoRoute({ grid, boat, from, to }) {
  const bounds = grid.bounds;
  const { rows, columns, cell } = bounds;
  const total = rows * columns;
  const engineGrid = {
    rows, columns, cellSizeM: cell,
    chartedDepthM: grid.depths,
    depthUncertaintyM: new Float64Array(total),
    flags: grid.flags,
  };
  const { pass } = passableCells(engineGrid, vesselFor(boat));
  let start, goal;
  try { start = indexOf(bounds, from); goal = indexOf(bounds, to); } catch { return null; }

  const flood = (seed) => {
    const seen = new Uint8Array(total);
    if (!pass[seed]) return { seen, count: 0 };
    const queue = new Int32Array(total);
    let head = 0, tail = 0, count = 0;
    queue[tail++] = seed; seen[seed] = 1;
    while (head < tail) {
      const i = queue[head++];
      count++;
      const r = Math.floor(i / columns), c = i - r * columns;
      if (r > 0) { const j = i - columns; if (!seen[j] && pass[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (r + 1 < rows) { const j = i + columns; if (!seen[j] && pass[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (c > 0) { const j = i - 1; if (!seen[j] && pass[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (c + 1 < columns) { const j = i + 1; if (!seen[j] && pass[j]) { seen[j] = 1; queue[tail++] = j; } }
    }
    return { seen, count };
  };

  const fromStart = flood(start);
  if (fromStart.seen[goal]) return null; // ulasilabilir; sorun baska
  const fromGoal = flood(goal);

  // Baslangicin ulastigi alanda, varisa en yakin hucre.
  const goalRow = Math.floor(goal / columns), goalCol = goal % columns;
  let best = null;
  for (let i = 0; i < total; i++) {
    if (!fromStart.seen[i]) continue;
    const r = Math.floor(i / columns), c = i - r * columns;
    const d = Math.hypot(r - goalRow, c - goalCol);
    if (!best || d < best.d) best = { d, index: i };
  }
  if (!best) return null;
  const nearest = {
    ...cellCentre(bounds, best.index, `${to.name ?? 'Varis'} (ulasilabilir su)`),
    distanceM: best.d * cell,
  };
  nearest.bearingDeg = initialBearingDeg(to.latitude, to.longitude, nearest.latitude, nearest.longitude);
  return {
    reason: 'isolated',
    reasonText: 'varis noktasi, baslangictan deniz yoluyla ulasilamayan kucuk bir cebin icinde',
    reachableCells: fromStart.count,
    pocketCells: fromGoal.count,
    requiredDepth: minimumDepthFor(boat),
    bufferM: boat.horizontalBuffer,
    effectiveBufferM: Math.ceil(boat.horizontalBuffer / cell) * cell,
    cellM: cell,
    usableBufferM: null,
    nearest,
  };
}

/** Keep direction changes and at least every 8th cell; never cut a corner. */""")

# --- NO_ROUTE dalinda teshisi kullan --------------------------------------
rep("""    if (result.status !== DR_OK) throw legError(result.status, from, to);""",
"""    if (result.status === DR_NO_ROUTE) {
      const isolated = diagnoseNoRoute({ grid, boat, from, to });
      // Kucuk, kopuk bir cep: alani genisletmek bir sey degistirmez. Kullaniciya
      // ulasilabilir en yakin suyu goster; dogrulanmamis etap secenegi acilsin.
      if (isolated && isolated.pocketCells > 0 && isolated.pocketCells < isolated.reachableCells / 20) {
        throw new PlanningError(
          `'${to.name ?? 'Varis'}' cevresi, baslangicinizdan deniz yoluyla ulasilamiyor: `
          + `girisi modelde ${isolated.requiredDepth.toFixed(1)} m'den sig ya da kapali gorunuyor. `
          + 'Dar korfez girislerinde model gridi (~115 m) yetersiz kalir; orasi gercekte gecilebilir olabilir. '
          + `Ulasilabilir en yakin su ${Math.round(isolated.nearest.distanceM)} m uzakta. Nokta kendiliginden tasinmadi.`,
          { blocked: to, diagnosis: isolated, status: result.status });
      }
      throw legError(result.status, from, to);
    }
    if (result.status !== DR_OK) throw legError(result.status, from, to);"""),

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('planner.js: diagnoseNoRoute eklendi')
