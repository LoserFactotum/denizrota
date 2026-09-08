# Doğrulama — 8 Eylül 2026

| Kontrol | Sonuç |
|---|---|
| Mesafe, kerteriz, knot, ETA: gerçek C kodu | 2.537 kontrol geçti |
| A*: sentetik engel, sığlık, bilinmeyen, köşe ve 300 bağımsız Dijkstra karşılaştırması | 5.238 kontrol geçti |
| GeoTIFF: 32 format varyasyonu, NoData, işaret, grid dönüşümü, kesilmiş/bozuk dosya; kıyı/adacık/pier geometrisi | 1.695 kontrol geçti |
| Xcode proje nesneleri, kaynak üyelikleri, plist ve scheme yapısı | Geçti — Swift derlemesi değildir |
| EMODnet gerçek WCS GeoTIFF indirmesi ve C okuyucu | HTTP 200; sayısal raster okundu |
| Overpass gerçek kıyı/engel indirmesi ve kıyı bütünlüğü | HTTP 200; 304 kıyı yolu, 381 engel geometrisi |
| Gerçek Datça–Bodrum gridinde A* | Rota bulundu; 478 yol hücresi |
| Her yol hücresi ve tampon; her geçiş ve diyagonal yan hücreler için bağımsız kontrol | Geçti |
| Swift derlemesi, iOS SDK, simulator/cihaz, UI, GPS, izinler, GPX paylaşım ekranı | Çalıştırılmadı — bu ortamda Xcode yok |

Gerçek servis testi Python adaptörüyle uygulamanın aynı C okuyucusunu, kıyı maskesini ve rota motorunu çalıştırır. Native Swift istemcisinin aynı servisleri iPhone’dan başarıyla kullanacağı henüz cihazda doğrulanmadı. Gerçek denizde test yapılmadı.

Sonuç değerleri: `evidence/live-report.json`. Yeniden üretme: `python3 scripts/live_check.py --output /tmp/denizrota-live`. Ağsız birim/format testleri: `python3 scripts/verify.py`.
