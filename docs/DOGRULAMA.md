# Doğrulama

Bu dosya, motorun **neyi kanıtladığını** ve neyi kanıtlamadığını yazar.

## 1. Port, özgün motoru birebir üretiyor

Web sürümünün motoru, iOS 0.2 sürümünün C çekirdeğinden (`ios/DenizRota/Core/`)
JavaScript'e port edildi. Portun doğruluğu tahmin edilmedi, ölçüldü:
`evidence/` klasöründe 8 Eylül 2026'da gerçek servislerden alınmış EMODnet
GeoTIFF ve Overpass JSON yanıtları, ve o veriyle C motorunun ürettiği sonuçlar
duruyor. `test/regression.mjs` aynı girdiyi JavaScript motoruna verir ve şunları
**tam eşitlik** ile karşılaştırır:

| Karşılaştırılan | Beklenen |
|---|---|
| Kanıt dosyalarının SHA-256'sı | `live-report.json` içindeki değerler |
| Çözülen raster boyutu ve grid adımı | 691 × 644, 0,0010421445299677622° |
| Planlama alanı sınırları | `grid-bounds.json` ile birebir |
| Kıyı yolu / parça / engel sayısı | 304 / 34.399 / 381 |
| **Kara-deniz maskesi** | `grid-mask.bin` ile **bayt bayt aynı** (200.334 hücre) |
| Yol hücresi sayısı | 478 |
| Grid mesafesi | 41,58618737760527 deniz mili |
| Yoldaki en sığ model derinliği | 8,41796875 m |
| **Yol geometrisi** | `route.geojson` ile **hücre hücre aynı** |
| Bağımsız pay denetimi | temiz |

Bu, kayan nokta işlem sırasına kadar aynı davranış demektir. Bunu korumak için
bazı ifadeler bilerek "gereksiz" biçimde yazıldı — örneğin `(satır × hücre) / ky`,
`satır × (hücre / ky)` değil.

## 2. Birim testleri

`test/unit.mjs`, özgün C ve Python test takımlarının portudur — aynı senaryolar,
aynı tohumlar:

**Seyir matematiği** (`ios/tests/NavigationMathTests.c`)
Analitik referanslar, tarih çizgisi geçişleri, kutuplar, 500 nokta çiftinde
simetri ve aralık özellikleri. Geçersiz girdide değer uydurulmaz: geçersiz
koordinat, negatif hız, durmuşken varış saati — hepsi tanımsız döner.

**Raster ve geometri** (`ios/tests/MarineGridTests.py`)
32 geçerli GeoTIFF kodlama varyasyonu (büyük/küçük endian × sıkıştırma ×
pixel-is-point × ModelTransformation × işaretli tamsayı), her biri için doğru
en sığ derinlik. Ardından reddetmesi gerekenler: dosyanın her kesilmiş hali,
`<ServiceException>` hata sayfası, 1000 rastgele bayt dizisi. Maske testleri:
saat yönünün tersine ada, iki kenardan çıkan anakara kıyısı, bir hücreden küçük
adacık, poligon içi, hücre merkezleri arasından geçen ince iskele.

**Rota arama** (`ios/tests/AutoRouterTests.c`)
Sığ geçişin su çekimi/belirsizlik/pay arttıkça kapanması, bilinmeyen ve engelli
bariyerlerde düz çizgiye düşülmemesi, köşe kesmeme, kapalı başlangıç/varışın
taşınmaması, pay uygulaması, geçersiz girdiler. Sonra **300 rastgele gridde**
bağımsız bir O(V²) Dijkstra ile birebir mesafe karşılaştırması.

Toplam: **143 kontrol**, `npm test` ile ~250 ms, ağ gerektirmez. Bunlara Deflate
bloklarında dolgu/bozulma ayrımı ve eşit-x kıyı kesişimleri de dahildir.

## 3. Gerçek veriyle uçtan uca

`test/live.mjs` gerçek servislere gider ve tam akışı çalıştırır. 9 Eylül 2026,
Bencik ağzı → Palamutbükü:

```
75 m hücre · 1248 × 964 grid · 636 yol hücresi · 10 dönüş noktası
27,18 deniz mili · 5 knot ile 5 sa 26 dk
yoldaki en sığ model derinliği 12,28 m (eşik 7,5 m)
bilinmeyen hücre 0 · engel geometrisi 509 · kıyı yolu 558
```

(Düzleştirmeden önce aynı yol 117 nokta ve 28,67 nm idi.)

Sonuçlar `evidence/bencik-palamut/` içinde: istek URL'leri, kaynak SHA-256'ları,
maske ve GeoJSON.

## 4. Bağımsız çalışma zamanı denetimi

Test dışında, **her hesapta** rota teslim edilmeden önce iki denetim sıfırdan
çalışır:

- `auditPath` — A*'ın ham yolu: her hücre, o hücrenin tüm pay komşuluğu, her
  diyagonal geçişin iki yanı, ve yolun gerçekten istenen başlangıç/varış
  hücrelerini birleştirdiği.
- `auditSegments` — düzleştirilmiş bacaklar: iki dönüş noktası arasındaki düz
  çizginin geçtiği **her** hücre (`lineCells`, köşe geçişlerinde iki yan hücre
  dahil) aynı pay komşuluğu kuralıyla.

Herhangi biri geçmezse rota **verilmez**, hata döner. Bu bilinçli bir tekrardır:
arama motorundaki ya da düzleştirmedeki bir hata sessizce geçerli görünen bir
rota üretemesin diye.

### Düzleştirme neden güvenli

Görüş hattı düzleştirmesi (`straighten`) bir bacağı ancak düz çizginin geçtiği
her hücre, kıyı/engel payı dahil, geçilebilirse birleştirir. Geçilebilirlik
`passableCells` ile hesaplanır — A*'ın kullandığı aynı dizi. Yani düz bacak,
yerine geçtiği merdivenin kullanmadığı hiçbir hücreye girmez; yalnızca
merdivenin zaten içinde kaldığı geçilebilir alanı daha kısa keser. Bencik →
Palamutbükü'nde 117 nokta 10'a, 28,67 nm 27,18 nm'e indi; en sığ model
derinliği değişmedi (12,28 m).

## 5. Kasıtlı değişiklikler (iOS 0.2'ye göre)

| Değişiklik | Neden güvenli |
|---|---|
| Hücre 150 m sabit yerine 40–150 m adaptif | Kıyı/engel geometrisi keskinleşir. Derinlik, hücre kaynak pikselinden küçükse en az bir piksel genişliğinde pencerenin en sığ değerinden alınır (`minDepth` padX/padY); pay=0'da C ile birebir aynıdır. |
| Marmaris–Datça–Bodrum enlem/boylam kapısı kaldırıldı | Sınır güvenlik değil, hesap bütçesiydi. Yerine yalnızca hücre sayısı sınırı var. |
| `coastMask` içinde satır bandı indeksi | Yalnızca tarama çizgisini kesemeyecek parçaları atlar; regresyon maskesi bayt bayt aynı kalır. |
| `passableCells` paylaşıldı | Aynı kod hem rota aramasında hem teşhiste; ikisi asla ayrışamaz. |
| Kullanılamayan nokta teşhisi | Yeni. Öneri **deniz yoluyla** aranır (kuş uçuşu arama bir kıstakta yanlış körfezi önerebiliyordu) ve nokta kullanıcı onaylamadan taşınmaz. |
| Görüş hattı düzleştirmesi | Yeni. Yalnızca geçilebilir hücrelerden geçen düz bacaklar; ayrı denetim (`auditSegments`). Ham yol ve regresyon değişmez. |
| Doğrulanmamış uç etap | Yeni, yalnızca arayüzde. Motor asla doğrulanmamış hücreden rota geçirmez; kullanıcı, gerçek ucuyla en yakın uygun su arasındaki parçayı **açıkça etiketli** kırmızı kesikli çizgi olarak ekleyebilir. Bu parça hiçbir yerde "doğrulandı" diye geçmez. |

## 6. Yapılmamış olan

- Swift/iOS derlemesi ve cihaz testi hâlâ yapılmadı (Mac yok). `ios/` arşivdir.
- Gerçek denizde saha testi yapılmadı.
- Tek bir bölgede yapılan gerçek veri testi, tüm bölgeler için doğrulama değildir.
- Tarayıcı GPS, wake-lock ve çevrimdışı davranışı gerçek cihazda kullanıcı
  tarafından denenmelidir; otomatik testi yoktur.
