# Otomatik rota — 0.2 uygulaması

Önceki sürümdeki yalnızca sentetik grid motoru, bu sürümde kullanıcının istediği açık model tabanlı deneysel planlama akışına bağlandı.

## Veri zinciri

`MarineDataService.swift` → EMODnet WCS `emodnet:mean`, WCS 1.0.0, EPSG:4326, GeoTIFF, nearest, nominal 1/960 derece → `MarineGrid.c` sayısal okuyucu.

İkinci istek Overpass `out body geom`: OSM `natural=coastline`, seamark rock/wreck/obstruction/restricted_area/military_area/marine_farm, man_made pier/breakwater/groyne ve natural=reef. OpenSeaMap döşemeleri yalnızca görseldir; piksellerden engel çıkarılmaz. Sorgu veritabanı tarihi kaydedilir. Kaynaklar eksiksiz engel envanteri değildir.

EMODnet’in GEBCO ile doldurulmuş modeli kullanılır; ayrı GEBCO dosyası indirme/fallback uygulanmamıştır. Hücrelerin kaynak referansı/TID ayrımı henüz yapılmaz. UI bunu belirtir.

## Dönüşüm ve maske

GeoTIFF: classic TIFF, big/little endian, tek bant signed 16/32-bit veya float 32/64-bit; strip/tile; sıkıştırmasız veya Deflate; predictor=1. WGS84 geographic CRS doğrulanır. Pixel-is-area ve pixel-is-point, Scale/Tiepoint veya north-up affine ModelTransformation desteklenir. Döndürülmüş grid, BigTIFF, LZW, predictor 2/3, RGB ve başka CRS reddedilir. NoData/NaN bilinmeyen kalır; RGB renkler derinlik sayılmaz.

8 Eylül 2026 gerçek EMODnet yanıtı big-endian float32, tiled, sıkıştırmasız, ModelTransformation ve EPSG:4326 olarak başarıyla okundu. Kaynak WCS grid boyutuna yuvarlama nedeniyle dönüşteki gerçek aralık nominal istekten az farklı olabilir; dosyadaki dönüşüm kullanılır.

Yerel eşdikdörtgensel metrik yaklaşımda enlem ölçeği Rπ/180, boylam ölçeği Rπ/180·cos(orta enlem). 150 m grid. UTM değildir; bölgesel yaklaşık mesafe/geometri hesabıdır. Alan, nokta sınırlarının her yanında en az 0,18 derece genişletilir; kaynak istekleri ayrıca 0,01 derece dışarı taşar. En çok 1.000.000 hücre ve 20 giriş noktası.

OSM kıyı çizgilerinin içerideki her düğümünde bir gelen/bir giden kenar zorunludur. Kıyı kenarlarına değen hücreler bloke edilir. Yönlü tarama ve bağlı bileşenler deniz/kara ayrımı yapar; çelişkili veya tohumsuz bileşenler bilinmeyen kalır. Engellerin çizgileri ve poligon içleri boyanır; relation outer halkaları birleştirilir, inner boşluklar ihtiyatlı olarak açılmaz. Alt hücre ölçeğindeki kıyı/engel çizgileri hücre yarı köşegeniyle rasterlenir. Kapsam ve bütünlük, OSM kaynağı kadar iyidir.

Deniz hücresine değen tüm kaynak piksellerin en sığ model derinliği alınır; biri eksikse hücre bilinmeyendir. EMODnet WCS yükseltileri derinliğe eksi işaretiyle çevrilir. Bu, hücre içinde fiziksel en sığ noktanın ölçüldüğü anlamına gelmez.

## A* ve çıktı

`AutoRouter.c` sekiz komşulu A*, 1 / √2 adım maliyeti, ikili heap. Diyagonal geçişte iki yan hücre de açık olmalıdır. Kıyı/engel uzaklığı `ceil(pay/hücre)` kare komşuluğuyla, sığlıklar ve bilinmeyenler dahil uygulanır. Dış grid de kapalıdır.

Derinlik koşulu su çekimi + omurga altı pay + kullanıcı model payı + su düşüş payıdır. Bu adaptör ölçülmüş belirsizlik sahibi olmadığı için C motorunun belirsizlik dizisini sıfır kullanır ve kullanıcı payını ayrıca geçirir; sıfır gerçek veri hatası iddiası değildir.

Uçlar kaydırılmaz. Her gerçek uç, yalnızca kendi kontrol edilmiş hücresinin merkezine bağlanır. Her ara nokta ayrı etap sınırıdır. Hücre yolunda sadece aynı yöndeki ardışık noktalar sadeleştirilir; en geç sekiz adımda bir nokta korunur. Engel üzerinden serbest düzleştirme yoktur. iOS harita/mesafe çizimi kısa küresel parçalar kullanır; metrik grid yaklaşımı ile küçük fark vardır.

Kaynak SHA-256, indirme tarihi, OSM tarihi, tekne ayarları ve rota geometrisi kayıtla saklanır. Geometri değişirse otomatik kontrol etiketi geçersiz olur. Yalnızca ad/hız değişmesi geometriyi değiştirmez. GPX deneysel kaynak notunu içerir.

## Açık sınırlar

Swift/iOS derlemesi ve UI/GPS uçtan uca test henüz yapılmadı. Tek gerçek Datça–Bodrum entegrasyon testi bölgenin tamamı için doğrulama değildir. Grid modeli dar liman yaklaşmalarını çözmeyebilir. Güncel seyir yasağı, hareketli gemi, AIS, canlı hava/akıntı/gelgit, kıyıdan otomatik snap, rota dışı güvenli yeniden yönlendirme ve indirilmiş çevrimdışı harita paketi yoktur.
