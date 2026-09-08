# Gerçek servis testinin kanıt dosyaları

8 Eylül 2026 tarihinde alınan EMODnet WCS GeoTIFF ve OSM Overpass JSON yanıtlarıdır. Dosya isimleri istek kimliğinin SHA-256 özetidir; yanıt içeriklerinin SHA-256 değerleri `live-report.json` içinde bulunur.

`route.geojson` C motorunun test yolu, `grid-mask.bin` kuzeyden güneye satır sıralı byte hücreleridir. `grid-bounds.json` sınır ve boyutları belirtir. PNG bu gerçek veriden üretilmiş test görselidir, iPhone ekran görüntüsü değildir.

EMODnet Bathymetry DTM: https://emodnet.ec.europa.eu/en/bathymetry — GEBCO dolgusu içeren model. GEBCO: https://www.gebco.net/data-products/gridded-bathymetry-data . Veriler seyir için hazırlanmış resmi harita değildir.

OSM verisi © OpenStreetMap katkıcıları, Open Database License 1.0: https://www.openstreetmap.org/copyright ve https://opendatacommons.org/licenses/odbl/1-0/ . OSM tabanlı maske ve test rota verisi de bu atıfla paylaşılır. Başlangıç/varış test koordinatlarıdır; kullanıcı konum geçmişi içermez.

Bu dosyalar Xcode Resources aşamasına eklenmemiştir; native istemci kendi seçtiğin alanı servislerden indirir. Python testini bu klasörle yeniden çalıştırırsan aynı önbellek verilerini kullanır: `python3 scripts/live_check.py --output evidence`.
