// Kaynak indirme katmani: Overpass kutusunun disari yuvarlanmasi ve daha genis
// bir onbellek girdisinin yeniden kullanilmasi.
//
// Bunlar teknede onemli: Overpass IP basina slot verir, zayif LTE'de her rota
// icin yeniden indirmek hesabi tamamen durdurabiliyordu. Testler ag kullanmaz —
// onbellek isabet ettiginde fetch'e HIC gidilmedigi de dogrulanir.

import { planningBounds, overpassBBox, OVERPASS_SNAP_DEGREES } from '../engine/grid.js';
import { fetchOSM, overpassQueryForBBox } from '../engine/sources.js';

const anchors = (a, b) => [
  { name: 'A', latitude: a[0], longitude: a[1] },
  { name: 'B', latitude: b[0], longitude: b[1] },
];

export async function run(check) {
  // ---------------------------------------------------- kutu yuvarlanmasi
  check.equal(OVERPASS_SNAP_DEGREES, 0.25, 'yuvarlama adimi 0,25 derece');

  const bounds = planningBounds(anchors([36.78096, 28.04397], [36.81830, 28.29293]), { cell: 60, margin: 0.25 });
  const bbox = overpassBBox(bounds).split(',').map(Number);
  const step = OVERPASS_SNAP_DEGREES;
  let offGrid = 0;
  for (const value of bbox) if (Math.abs(value / step - Math.round(value / step)) > 1e-9) offGrid++;
  check.equal(offGrid, 0, 'kutunun dort kenari da 0,25 derece izgarasinda');

  // Yuvarlama DISARI dogru olmali: gercek alan her zaman icinde kalsin.
  check.ok(bbox[0] <= bounds.south - 0.01, 'guney kenari disari yuvarlandi');
  check.ok(bbox[1] <= bounds.west - 0.01, 'bati kenari disari yuvarlandi');
  check.ok(bbox[2] >= bounds.north + 0.01, 'kuzey kenari disari yuvarlandi');
  check.ok(bbox[3] >= bounds.east + 0.01, 'dogu kenari disari yuvarlandi');
  check.ok(bbox[2] - bbox[0] < 2 && bbox[3] - bbox[1] < 2, 'yuvarlama kutuyu asiri buyutmuyor');

  // Sorgu metni kutudan uretilebilmeli (onbellekten gelen kutu icin de gerekir).
  const query = overpassQueryForBBox(bbox.join(','));
  check.ok(query.includes(bbox.join(',')), 'sorgu metni verilen kutuyu iceriyor');
  check.ok(query.includes('natural"="coastline'), 'sorgu kiyi cizgisini istiyor');
  check.ok(query.includes('out body geom'), 'sorgu geometri istiyor');

  // ------------------------------------------- kapsayan onbellek girdisi
  const payload = new TextEncoder().encode('{"elements":[]}');
  const downloadedAt = Date.now() - 60000;
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw new Error('ag kullanilmamaliydi'); };

  try {
    // Kapsayan girdi: her yonde daha genis.
    const wide = [bbox[0] - 0.5, bbox[1] - 0.5, bbox[2] + 0.5, bbox[3] + 0.5];
    const hitCache = {
      async findContaining(family, wanted) {
        check.equal(family, 'overpass', 'onbellek dogru aile ile sorgulandi');
        const ok = wide[0] <= wanted[0] && wide[1] <= wanted[1] && wide[2] >= wanted[2] && wide[3] >= wanted[3];
        return ok ? { bytes: payload, downloadedAt, bbox: wide } : null;
      },
      async get() { return null; },
      async put() {},
    };
    const hit = await fetchOSM(bounds, { cache: hitCache });
    check.equal(networkCalls, 0, 'kapsayan onbellek girdisi varken ag kullanilmadi');
    check.equal(hit.fromCache, true, 'sonuc onbellekten isaretlendi');
    check.equal(hit.downloadedAt, downloadedAt, 'indirme zamani onbellekteki deger');
    check.equal(hit.endpoint, 'onbellek', 'kaynak olarak onbellek bildirildi');
    check.equal(hit.cachedBBox, wide.join(','), 'kullanilan gercek kutu kayda gecti');
    check.ok(hit.query.includes(wide.join(',')), 'kayitli sorgu ONBELLEKTEKI kutuyu gosteriyor');
    check.equal(new TextDecoder().decode(hit.bytes), '{"elements":[]}', 'onbellekteki veri dondu');

    // Kapsamayan girdi kullanilmamali: kismi veri eksik kiyi demektir.
    const missCache = {
      async findContaining() { return null; },
      async get() { return null; },
      async put() {},
    };
    let reachedNetwork = false;
    try {
      await fetchOSM(bounds, { cache: missCache, retryWaitsMs: [0] });
    } catch {
      reachedNetwork = networkCalls > 0;
    }
    check.ok(reachedNetwork, 'kapsamayan onbellekte aga gidildi');
  } finally {
    globalThis.fetch = realFetch;
  }
}
