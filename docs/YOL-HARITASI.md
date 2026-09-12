# Yol haritası

Bu belge, 9 Eylül 2026 gecesi konuşulan ve **henüz yapılmamış** işleri, alınan
tasarım kararlarını ve cevap bekleyen soruları tutar. Yapılmış özellikler
[README](../README.md)'de.

Taslak kod `taslak/capa-nobeti-ve-hava` dalında duruyor; `main`'e ve canlıya
bağlı değil. Tercihler netleşince oradan devam edilir.

---

## 0. AÇIK HATA: seyir takibi çalışmıyor — öncelik 0

**Durum:** Kullanıcı 12 Eylül 2026'da teknede bildirdi: *"takip çalışmıyor."*
Ayrıntı alınamadı (tur bitti, geliştirme durduruldu). **Neden bilinmiyor** —
aşağıdakiler doğrulanmamış tahminlerdir, önce üretilip teşhis edilmeli.

Bakılacak yerler (`web/app.js`):

- `usableFix()` filtresi fazla katı olabilir: doğruluk ≤ 50 m **ve** yaş ≤ 15 sn.
  Cihaz saati ile GPS zaman damgası arasındaki fark, ya da `watchPosition`'ın
  önbellekten konum döndürmesi geçerli sabitlemeleri eleyebilir. Filtre elerse
  arayüz "GPS bekleniyor" der ve takip hiç başlamaz.
- Takip yalnızca **hesaplanmış** rota varken açılıyor (`track-button` sonuç
  bloğunun içinde). Elle çizilen rotada düğme hiç görünmez — kullanıcı bunu
  "çalışmıyor" olarak yaşamış olabilir.
- iOS Safari'de PWA arka plana alınınca konum akışı durur; öne dönünce yeni
  sabitleme beklenir.
- `wakeLock` reddedilirse ekran kilitlenir ve takip fiilen durur.
- 50 m'de sonraki noktaya geçiş (`ADVANCE_METRES`) düzleştirmeden sonra
  bacaklar uzadığı için beklenenden farklı davranıyor olabilir.

**Yapılacak:** önce gerçek cihazda üret, `watchPosition` çıktısını ham olarak
logla (doğruluk, yaş, hız), sonra filtreyi gerçek veriye göre gevşet. Otomatik
testi yok; tarayıcı GPS'i taklit edilerek test edilebilir.

---

## 1. Çapa nöbeti — öncelik 1

**Ne:** Demirledikten sonra "Çapayı bıraktım" → çapa noktası + salınım
yarıçapı. Tekne daireden çıkarsa **sesli alarm + titreşim + kırmızı ekran**.

**Kararlaştırılan tasarım (onay bekliyor):**
- Çapa noktası = düğmeye basıldığı andaki tekne konumu; sonra haritada
  sürüklenebilir. Yarıçap varsayılanı 45 m (zincir boyu + GPS payı ±10–15 m),
  15–200 m aralığında kaydırıcı.
- Alarm **iki ardışık** GPS okumasında daire dışındaysa çalar (tek sapmayla
  yanlış alarm olmasın). GPS 60 sn kesilirse **ayrı, pes** bir ton.
- "Sustur (2 dk)" ve onaylı "Bitir". Susturma alarmı iptal etmez, erteler.
- **Gece ekranı:** siyah zemin, kırmızı büyük rakam (çapadan uzaklık), yarıçap,
  GPS doğruluğu, saat. Dokununca normale döner. Wake-lock sürer.
- Çapa durumu cihazda saklanır; sayfa yenilense de nöbet sürer.
- Teknenin çapadan beri çizdiği iz haritada gösterilir (salınım deseni).

**Dürüst sınır:** PWA olduğumuz için **ekran kilitlenirse tarayıcı GPS'i ve sesi
durdurur.** Telefon şarjda ve gece ekranında açık kalmalı. Bu, native
uygulamalardan geri kaldığımız tek nokta; arayüzde açıkça yazılacak.

**Taslak durumu:** `web/alarm.js` (ses) ve `mapview.setAnchor` (daire + iz)
hazır ve testli; arayüz ve `app.js` bağlantısı yapılmadı.

## 2. Rota boyunca rüzgâr ve dalga — öncelik 1 (Seviye 1)

**Ne:** Her dönüş noktası için **oraya varılacak saatteki** rüzgâr (hız, yön,
hamle) ve dalga (yükseklik, yön, periyot, swell). Etap başına:
- yelken açısı: *rüzgâr burundan / orsa / apaz / geniş apaz / pupa*
- uyarılar: sert rüzgâr, fırtına sınırı, hamle, yüksek dalga, **bordadan dalga**
- hafif havada "motor" notu
- haritada dönüş noktalarında rüzgâr okları (renk şiddete göre)

**Kaynak:** Open-Meteo (ücretsiz, anahtarsız, CORS açık). 9 Eylül'de
doğrulandı: tek istekte çoklu konum, saatlik, `wind_speed_unit=kn`; deniz
modeli dalga yüksekliği/yönü/periyodu/swell veriyor.
**Sınır:** grid ~9 km (36,70/27,70 istendi, 36,708/27,708'e yuvarlandı).
Datça'nın rüzgâr gölgesi, burun hamleleri, öğleden sonra hızlanan meltem
termiği **çözülmez**. Kıyıdan açıkta iyi, koy içinde kaba — arayüzde yazılacak.

**Kararlaştırılan:** rota hesaplanınca otomatik çekilir (birkaç KB), 45 dk
önbellek; kalkış saati veya hız değişince yenilenir. Manuel (hesaplanmamış)
rotada da gösterilir.

**Varsayılan eşikler (kullanıcı onayı bekliyor):** motor < 6 kn · sert ≥ 22 kn ·
fırtına sınırı ≥ 30 kn · hamle ≥ 33 kn · dalga uyarı ≥ 1,5 m · bordadan dalga
dikkat ≥ 1,0 m · orsa yapılamaz < 45°.

**Taslak durumu:** `web/weather.js` (indirme + enterpolasyon + değerlendirme)
ve `test/weather.mjs` (32 kontrol) hazır; `mapview.setWind` hazır; arayüz yok.

## 3. Kalkış saati — öncelik 1 (2'nin ön koşulu)

"Şimdi çıkarsan" yerine kalkış saati seçici (`datetime-local`, "Şimdi" düğmesi).
Her dönüş noktasına **varış saati**; her etap için **gün batımı kontrolü**
("Knidos burnunu karanlıkta dönüyorsun" gibi). Nokta listesinde varış
saatlerinin görünmesi kullanıcıya soruldu.

## 4. Gerçek hava rotalaması — Seviye 2, sonraki adım

**Ne:** Rota rüzgâra göre *seçilir* (PredictWind / qtVlm / OpenCPN mantığı).
**Yöntem:** izokron — kalkıştan itibaren her 30 dakikada teknenin tüm yönlerde
nereye varabileceği, o noktadaki o saatteki rüzgâra ve **polar diyagrama**
göre hesaplanır; ulaşılabilir sınır ilerletilir; varışa ilk dokunan yol en
hızlısıdır. Rüzgâr burundansa polar "45°'den yakın olmaz" der, algoritma
kendiliğinden volta atar; hafif havada motor hızına düşer.

**Güvenlik ilkesi (değişmez):** izokronlar yalnızca **geçilebilir hücreler**
üzerinde ilerler. Derinlik, kıyı payı, bağımsız denetim — hiçbiri gevşemez.
"En hızlı yelkenli rota" ile "en kısa güvenli rota" yan yana gösterilir.

**Gereksinimler:**
- Dufour 470 polar diyagramı (üretici / ORC). Yoksa "≈47 ft kruvazör,
  yaklaşık" etiketli genel polar; ekranda açıkça yazılır.
- Kullanıcı tercihleri: motor eşiği, azami dalga, volta mı motor mu, gece
  seyri istenir mi.
- Zaman-mekân hava gridi: Open-Meteo'dan ~0,1° aralıklı noktalar (çoklu konum
  isteği; ücretsiz kota 10k/gün yeter).

**Sınır:** tahmin ufku 3–7 gün; 24 saat öncesi anlamlı. 9 km grid nedeniyle
kıyıya yakın öneriler yaklaşık; yerel bilgi üstün.

## 5. Kendi iskandilin — ileride

**Bulgu (9 Eylül):** Bencik gibi dar koylar için **ücretsiz yüksek çözünürlüklü
derinlik verisi yok.** Doğrulandı:
- EMODnet'in Bencik hücreleri `GEBCO2024` + `Coastal_heights_2024`
  kaynağından; **hiç iskandil ölçümü girmemiş**.
- EMODnet yüksek çözünürlük katmanları: Türkiye Ege kıyısında **0 ayak izi**
  (bölgedeki tek alan Santorini).
- IHO Kitle Kaynaklı Batimetri (CC0, açık): Güneybatı Türkiye kutusunda
  **0 iskandil**.
- SHODB: iskandil verisi var ama "Veri Talep Formu" ile kurumsal; açık veri yok.
- Navionics SonarChart / Garmin Quickdraw: kendi ekosistemlerine kapalı.

**Yol:**
1. **Elle kayıt** — "İskandil kaydet": GPS konumu + göstergeden okunan
   derinlik. Haritada "kendi ölçümüm" etiketiyle; doğrulanmamış etap
   "kendi iskandilimle görülmüş" sınıfına çevrilebilir (modelle doğrulanmış
   gibi **değil**, ayrı sınıf).
2. **Otomatik** — teknede Signal K / NMEA-WiFi varsa WebSocket ile
   `environment.depth.belowTransducer` + `navigation.position`. HTTPS sayfa
   tekne ağındaki `ws://`'ye bağlanamaz; çözüm DenizRota'yı **Signal K web
   uygulaması** olarak paketlemek.
3. Kayıtları **IHO CSB'ye CC0 olarak yüklemek** — Türk sularında ilk açık
   iskandil katkısı.

Kullanıcı: "şimdilik atlayalım."

## 6. Daha küçük öneriler

| Özellik | Değer | Tahmini iş |
|---|---|---|
| **MOB — adam denize düştü** | tek dokunuş: konumu işaretle, kerteriz/mesafe geri, alarm | ~30 dk |
| Gece modu (kırmızı/koyu arayüz) | gece vardiyasında göz | ~20 dk |
| Etap derinlik profili (grafik) | daralan yerler bir bakışta | ~40 dk |
| Sesli uyarılar (sapma, sığlık, varış) | rüzgârda titreşim duyulmaz | ~20 dk — `alarm.js` hazır |
| Nokta listesinde varış saatleri | 3 ile birlikte | ~10 dk |

**Yapılmayacaklar (şimdilik):** AIS (alıcı gerekir), gelgit (Ege'de ihmal
edilebilir), toplu harita döşemesi indirme (OSM kullanım kuralına aykırı).

## 7. Cevap bekleyen sorular

1. Seviye 1 önce, Seviye 2 sonra — uygun mu, yoksa doğrudan Seviye 2 mi?
2. Dufour 470 polar diyagramı var mı? Hangi salma (standart 2,2 m / sığ 1,8 m)?
3. Motor eşiği, azami rahat rüzgâr/dalga, volta mı motor mu?
4. Hava otomatik mi, düğmeyle mi çekilsin? (öneri: otomatik + 45 dk önbellek)
5. Çapa nöbeti: 45 m varsayılan, iki ardışık okuma kuralı, 60 sn GPS kaybı
   tonu — uygun mu? Demirde telefon şarjda kalıyor mu?
6. Kalkış saati: nokta listesinde varış saatleri görünsün mü?

## 8. Çalışma biçimi

Önce konuş, onay al, sonra kodla. Motor kurallarını (en sığ piksel, bilinmeyen
geçilmez, bağımsız denetim, deniz yoluyla arama, onaysız nokta taşıma yok)
hiçbir özellik için gevşetme. Her özellik: test + README + `DOGRULAMA.md`.
