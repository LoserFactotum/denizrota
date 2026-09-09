// Hava modulunun saf hesap fonksiyonlari. Ag yok; enterpolasyon, ruzgar acisi
// ve etap degerlendirmesi. Bir yelkenli icin yanlis "orsa" ya da kacirilan
// "bordadan dalga" uyarisi gercek bir karari etkiler, o yuzden burada sabitlenir.

import {
  interpolateLinear, interpolateDirection, trueWindAngle, pointOfSail, assessLeg,
} from '../web/weather.js';

export async function run(check) {
  const hours = [0, 3600, 7200, 10800]; // saniye
  const ms = (s) => s * 1000;

  // --- dogrusal enterpolasyon
  check.close(interpolateLinear(hours, [10, 20, 30, 40], ms(1800)), 15, 1e-9, 'yarim saatte dogrusal orta deger');
  check.equal(interpolateLinear(hours, [10, 20, 30, 40], ms(-100)), 10, 'baslangictan once ilk deger');
  check.equal(interpolateLinear(hours, [10, 20, 30, 40], ms(99999)), 40, 'bitisten sonra son deger');
  check.equal(interpolateLinear(hours, [10, NaN, 30, 40], ms(1800)), 10, 'komsu NaN ise bilinen taraf');
  check.ok(Number.isNaN(interpolateLinear([], [], 0)), 'bos dizi NaN');

  // --- yon enterpolasyonu (vektor)
  check.close(interpolateDirection(hours, [350, 10, 20, 30], ms(1800)), 0, 1e-6, '350° ile 10° arasi 0°, 180° degil');
  check.close(interpolateDirection(hours, [90, 90, 90, 90], ms(5400)), 90, 1e-9, 'sabit yon sabit kalir');
  check.close(interpolateDirection(hours, [0, 180, 0, 0], ms(1800)), 0, 1e-6, 'tam zit vektorler: ilk yon korunur, uydurma yok');

  // --- gercek ruzgar acisi
  check.equal(trueWindAngle(0, 0), 0, 'ruzgar tam burundan');
  check.equal(trueWindAngle(0, 180), 180, 'ruzgar tam kicdan');
  check.equal(trueWindAngle(90, 0), 90, 'kuzey ruzgari doguya rotada apaz');
  check.equal(trueWindAngle(350, 10), 20, '360° sarmali dogru');
  check.equal(trueWindAngle(10, 350), 20, 'sarmal simetrik');
  check.ok(Number.isNaN(trueWindAngle(NaN, 90)), 'gecersiz rota NaN');

  // --- yelken acisi adlari
  check.equal(pointOfSail(30).key, 'headwind', '30° orsa yapilamaz');
  check.equal(pointOfSail(30).sailable, false, 'burundan ruzgar yelkenlenmez');
  check.equal(pointOfSail(55).key, 'closehauled', '55° orsa');
  check.equal(pointOfSail(90).key, 'beam', '90° apaz');
  check.equal(pointOfSail(130).key, 'broad', '130° genis apaz');
  check.equal(pointOfSail(170).key, 'run', '170° pupa');
  check.equal(pointOfSail(NaN), null, 'ruzgar yoksa aci yok');

  // --- etap degerlendirmesi
  const calm = assessLeg({ courseDeg: 270, wind: { speedKn: 3, gustKn: 6, dirDeg: 340 }, wave: { heightM: 0.3, dirDeg: 280 } });
  check.equal(calm.severity, 0, 'hafif hava sorun degil');
  check.ok(calm.warnings.some(w => /motor/.test(w)), 'hafif havada motor notu');

  const headwind = assessLeg({ courseDeg: 270, wind: { speedKn: 18, gustKn: 24, dirDeg: 275 }, wave: null });
  check.equal(headwind.severity, 1, 'burundan 18 kn dikkat');
  check.ok(headwind.warnings.some(w => /volta|motor/.test(w)), 'burundan ruzgarda volta/motor uyarisi');

  const gale = assessLeg({ courseDeg: 270, wind: { speedKn: 31, gustKn: 40, dirDeg: 0 }, wave: { heightM: 2.1, dirDeg: 10 } });
  check.equal(gale.severity, 2, 'firtina siniri ve 2 m dalga uyari');
  check.ok(gale.warnings.some(w => /firtina/.test(w)) && gale.warnings.some(w => /dalga/.test(w)), 'hem ruzgar hem dalga uyarisi');

  const beamSea = assessLeg({ courseDeg: 0, wind: { speedKn: 14, gustKn: 18, dirDeg: 90 }, wave: { heightM: 1.2, dirDeg: 95 } });
  check.equal(beamSea.severity, 1, '1,2 m bordadan dalga dikkat');
  check.ok(beamSea.warnings.some(w => /bordadan/.test(w)), 'bordadan dalga metni');

  const following = assessLeg({ courseDeg: 0, wind: { speedKn: 14, gustKn: 18, dirDeg: 180 }, wave: { heightM: 1.2, dirDeg: 180 } });
  check.equal(following.severity, 0, 'ayni yukseklikte kictan dalga uyari degil');

  const noWave = assessLeg({ courseDeg: 0, wind: { speedKn: 10, gustKn: 12, dirDeg: 90 }, wave: null });
  check.equal(noWave.severity, 0, 'dalga verisi yoksa ruzgar tek basina degerlendirilir');
  check.equal(noWave.sail.key, 'beam', 'dalga yokken yelken acisi yine hesaplanir');
}
