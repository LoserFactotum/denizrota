# DenizRota 0.2 — iOS deniz rotası prototipi

Marmaris–Datça–Bodrum için SwiftUI + MapKit uygulaması. Hesap/abonelik/API anahtarı gerektiren uygulama servisi içermez.

## Bu sürümde çalışan kod

- OpenSeaMap deniz işaretleri ve Apple temel haritası.
- Haritaya basılı tutarak başlangıç, ara nokta ve varış seçimi; koordinatla giriş.
- **Otomatik rota:** sayısal EMODnet WCS GeoTIFF indirmesi, OSM Overpass kıyı/engel indirmesi, kara/engel maskesi, su çekimi ve kullanıcı paylarıyla A* araması.
- **GEBCO, EMODnet DTM içindeki dolgu verisi üzerinden kullanılıyor.** Ayrı GEBCO API çağrısı veya hücre bazında EMODnet/GEBCO ayrımı yok. Bu iki kaynak bağımsız doğrulama sayılmaz.
- Su çekimi, omurga altı pay, model payı, su seviyesi düşüş payı, kıyı/engel uzaklığı.
- Mesafe, sabit hızla tahmini süre ve varış saati; GPS yer hızıyla kalan süre.
- Hesap alanını renklerle inceleme: bilinmeyen, sığ, kıyı/engel, derinlik koşuluna uygun hücreler.
- Yerel rota kaydı, kaynak tarihleri ve SHA-256 izleri, GPX dışa aktarma.
- Aynı istek için 24 saatlik dosya önbelleği; en çok sekiz kaynak yanıtı.

## iPhone’da deneme

1. Mac’te Xcode ile `DenizRota.xcodeproj` aç.
2. Signing & Capabilities bölümünde kendi Apple geliştirme takımını seç; bundle identifier gerektiğinde değiştir.
3. iPhone’u çalıştırma hedefi seçip Run düğmesine bas. iOS 17 veya üstü hedeflenir.
4. Haritada başlangıç/varış ekle → **Otomatik rota** → tekne ölçülerini değiştir → **Hesapla**.
5. Alanı ve sonucu incele → **Bu rotayı kullan**. Hızı ana ekranda knot olarak ayarla.

Bu teslim kaynak projedir; imzalı IPA veya TestFlight dağıtımı değildir. Bu ortamda Xcode/Swift/iOS SDK bulunmadığı için iOS derlemesi ve cihaz testi **yapılmadı**. Apple hesap/imzalama koşulları kendi kurulumuna bağlıdır.

## Doğrulama

```sh
python3 scripts/verify.py
```

9.470 kontrol geçti: gerçek uygulama C kodunda 2.537 navigasyon hesabı, 5.238 A* kontrolü, 1.695 sayısal raster/kıyı/engel kontrolü. Xcode proje dosyasının kaynak üyelikleri ve plist yapısı da doğrulandı; bu Swift derlemesi değildir.

İsteğe bağlı gerçek servis kontrolü (internet kullanır):

```sh
python3 scripts/live_check.py --output /tmp/denizrota-live
```

8 Eylül 2026 Datça açığı–Bodrum açığı testinde gerçek verilerle rota bulundu: **41,586 deniz mili; 5 knot ile yaklaşık 8 saat 19 dakika**. Bu değerler C grid yolunun uzunluğudur; iOS’un gerçek uç bağlantıları ve küresel mesafe hesabı küçük fark üretebilir. Her dönen hücre, komşu geçiş ve 150 m tampon ayrıca kontrol edildi. Ayrıntılar `TEST_RESULTS.md` ve `evidence/live-report.json` içinde.

## Hesabın kapsamı

150 m kare hesap hücreleri kullanılır. Bu, veri doğruluğu değildir: EMODnet’in nominal grid aralığı yaklaşık 115 m, GEBCO kaynak grid aralığı daha büyüktür. Her hücrede kesişen kaynak piksellerin en sığ model değeri alınır. Kara/kıyı maskesi raster derinliğinden bağımsız OSM geometrisinden de oluşturulur. Bilinmeyen hücreler geçilmez; kopuk kıyı, eksik geometri veya servis hatası durumunda rota uydurulmaz.

Seçili eşik: model derinliği ≥ su çekimi + omurga altı pay + ek model payı + su seviyesi düşüş payı. Model payı ölçülmüş belirsizlik değildir. Canlı gelgit, rüzgâr, dalga ve akıntı hesabı yoktur. İndirme tarihi, deniz tabanı ölçüm tarihi değildir. Açık model, küçük tehlikeleri ve liman geçişlerini çözmeyebilir; sonucu güncel harita ve gözlemle kontrol etmek gerekir.

Otomatik takip sıradaki noktaya 50 m içinde ilerler; uzak bir sonraki etaba atlamaz. Rotadan sapınca turuncu yön çizgisi yeni bir derinlik/engel kontrolü yapılmış rota değildir. Arka plan/ekran kilidi takibi yoktur.

## Kaynaklar

- [EMODnet Bathymetry: kapsam, grid, LAT referansı ve GEBCO dolgu](https://emodnet.ec.europa.eu/en/bathymetry)
- [EMODnet WCS servis açıklaması](https://emodnet.ec.europa.eu/en/emodnet-web-service-documentation)
- [GEBCO gridleri ve veri referansı](https://www.gebco.net/data-products/gridded-bathymetry-data)
- [OSM kıyı yönü: kara solda, su sağda](https://wiki.openstreetmap.org/wiki/Tag:natural%3Dcoastline)
- [OpenStreetMap katkıcıları — ODbL](https://www.openstreetmap.org/copyright)
- [OpenSeaMap](https://www.openseamap.org/index.php?L=1&id=faq)

Uygulama kodu ve test verisi ayrımı: `DenizRota/` uygulama kaynaklarıdır; `evidence/` gerçek servis testinin kanıt dosyalarıdır ve uygulamaya hazır harita paketi olarak gömülmez.
