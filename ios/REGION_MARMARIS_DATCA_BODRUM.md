# Marmaris · Datça · Bodrum çalışma alanı

Otomatik planlama giriş noktaları 36,2–37,4° K ve 26,8–28,8° D aralığıyla sınırlandırılır. Bu sınır uygulama çalışma alanıdır; deniz haritası kapsama veya seyredilebilir alan beyanı değildir. Girilen noktaların çevresindeki gerekli alt alan indirilir.

## Gerçek veri kontrolü — 8 Eylül 2026

Datça açığı test başlangıcı: 36,700° K, 27,700° D.
Bodrum açığı test varışı: 37,010° K, 27,435° D.
Bunlar test için seçilmiş açık deniz koordinatlarıdır; marina giriş noktaları veya kullanıcının GPS konumu değildir.

EMODnet: `emodnet:mean` WCS, GEBCO dolgusu içeren DTM. 691 × 644 sayısal kaynak pikseli.
OSM: 304 kıyı yolu / 34.399 kıyı segmenti ve 381 engel geometrisi.
Hesap grid’i: 519 × 386, 150 m hücreler.
A* çıktısı: 478 hücre, grid mesafesi 41,586 deniz mili.
Örnek tekne: su çekimi 1,5 m; omurga altı pay 1 m; model payı 5 m; su düşüş payı 0; yatay pay 150 m.
En sığ yol hücresinin model değeri 8,418 m; eşik 7,5 m.
5 knot sabit hız hesabı yaklaşık 8 saat 19 dakika; hava ve akıntı dahil değil.

Kaynak istekleri, veri SHA-256 değerleri, OSM zaman damgası ve sonuçlar `evidence/live-report.json` içinde. Gerçek örnek dosyalar test kanıtıdır; uygulamaya otomatik çevrimdışı bölge paketi olarak eklenmedi.

[EMODnet veri ve referans açıklaması](https://emodnet.ec.europa.eu/en/bathymetry)
[GEBCO veri açıklaması](https://www.gebco.net/data-products/gridded-bathymetry-data)
[OSM kaynak ve lisans](https://www.openstreetmap.org/copyright)
