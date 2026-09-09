// Test runner. No network, no build step: node test/run.mjs

const results = { passed: 0, failed: 0 };
const failures = [];

function format(value) {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export const check = {
  equal(actual, expected, label) {
    const ok = Object.is(actual, expected)
      || (typeof actual === 'number' && typeof expected === 'number' && actual === expected);
    if (ok) { results.passed++; return true; }
    results.failed++;
    failures.push(`${label}\n      beklenen: ${format(expected)}\n      gelen:    ${format(actual)}`);
    return false;
  },
  ok(value, label) { return this.equal(!!value, true, label); },
  close(actual, expected, tolerance, label) {
    const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
    if (ok) { results.passed++; return true; }
    results.failed++;
    failures.push(`${label}\n      beklenen: ${format(expected)} ±${tolerance}\n      gelen:    ${format(actual)}`);
    return false;
  },
  throws(fn, label) {
    try { fn(); } catch { results.passed++; return true; }
    results.failed++;
    failures.push(`${label}\n      beklenen: hata firlatmali\n      gelen:    hata yok`);
    return false;
  },
};

const suites = [
  ['birim testleri', './unit.mjs'],
  ['hava hesaplari', './weather.mjs'],
  ['gercek veri regresyonu', './regression.mjs'],
];

for (const [name, path] of suites) {
  const before = { ...results };
  const started = performance.now();
  const module = await import(path);
  await module.run(check);
  const took = Math.round(performance.now() - started);
  const passed = results.passed - before.passed, failed = results.failed - before.failed;
  console.log(`${failed ? 'BASARISIZ' : 'GECTI'}  ${name}: ${passed} kontrol${failed ? `, ${failed} hata` : ''} (${took} ms)`);
}

if (failures.length) {
  console.log('\nHatalar:');
  for (const failure of failures) console.log('  - ' + failure);
}
console.log(`\n${results.passed} kontrol gecti, ${results.failed} hata.`);
process.exit(results.failed ? 1 : 0);
