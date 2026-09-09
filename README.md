# DenizRota

**https://loserfactotum.github.io/denizrota/**

Teknenizin su çekimine göre **geçilebilir** bir rota arar. Açık batimetri modeli
(EMODnet, içinde GEBCO dolgusu var) ile OpenStreetMap'in kıyı, kayalık, batık,
resif ve iskele verisini birlikte kullanır. Hesap, abonelik ve API anahtarı
gerektirmez; kendi sunucusu yoktur.

Telefonda tarayıcıdan açılır, "Ana ekrana ekle" ile uygulama gibi çalışır.
Kurulum, Mac ve Xcode gerekmez.

> Bu resmi bir seyir haritası değildir. Güncel deniz haritası, fener listesi ve
> gözle kontrol yerine geçmez. Sınırları [aşağıda](#neye-güvenilmez) açıkça yazdım.

---

## Ne yapar

- **Yer arama** — koy, liman, burun, ada adı yazarsınız (Nominatim + Photon,
  Türkçe ad eşleşmesine göre sıralanır). Koordinat veya Google Maps bağlantısı
  da yapıştırabilirsiniz: `36.6661, 27.5105`, `36 40.5 N 27 30.2 E`,
  `https://www.google.com/maps/@36.674,27.504,15z`. Bulunduğunuz yeri tek
  dokunuşla başlangıç yapabilirsiniz.
- **Rota hesabı** — noktalar arası, teknenizin ölçülerine uyan geçişi arar,
  sonra bir denizcinin dümen tutacağı düz bacaklara indirger (görüş hattı
  düzleştirmesi; düz çizginin geçtiği her hücre yeniden denetlenir).
- **Derinlik katmanı** — teknenizin gereksinimine göre renklendirilmiş bantlar,
  yakınlaştırınca iskandil rakamları; geçilmez sığlık kırmızı, sınırdaki
  derinlik turuncu. İkinci dokunuşta hücre durumu (kara / kıyı-engel / bilinmiyor).
- **Karasuları sınırı** — rota, başlangıç noktanızın bulunduğu karasularından
  çıkmaz (varsayılan açık; kapatılabilir). Sınır her durumda haritada çizilir.
  Kaynak OpenStreetMap'tir ve **hukuki dayanak değildir** — aşağıya bakın.
- **Neden olmadığını söyler** — bir nokta kullanılamıyorsa sebebini, en büyük
  uygun kıyı payını ve **deniz yoluyla** en yakın uygun suyu gösterir. Noktayı
  kendiliğinden taşımaz; önce haritada gösterip onay ister.
- **Doğrulanmamış uç etap** — model dar bir koyun içini çözemiyorsa, koyun
  başından açık suya kadar olan parçayı **kırmızı kesikli** ve açıkça
  "derinlik kontrolü yok" etiketiyle ekleyebilirsiniz. Mesafeye girer, GPX'e
  notla gider, seyirde sürekli uyarır — ama asla doğrulanmış gibi gösterilmez.
- **Seyir takibi** — GPS yer hızı, kalan mesafe/süre, varış saati, kerteriz,
  rotadan sapma uyarısı, sığ/engelli alan uyarısı, ekranı açık tutma.
- **İz kaydı** — seyir boyunca gidilen gerçek iz cihazda saklanır ve GPX
  `<trk>` olarak indirilir; sayfa yenilense de kaybolmaz.
- **GPX indirir/yükler**, rotaları cihazda saklar, paylaşılabilir bağlantı üretir.
- **Varış gün batımından sonra mı** — yerel hesapla söyler.
- **Tekne ön ayarları** — Dufour 470 (standart / sığ salma) hazır; her ölçü
  elle değiştirilebilir.
- **Çevrimdışı** — uygulama kabuğu ve daha önce görülmüş harita döşemeleri
  önbelleğe alınır; hesaplanmış rota ve takip çekim olmadan da çalışır.

## Nasıl karar verir

Alan kare hücrelere bölünür (alana göre 40–150 m; ne kadar küçükse kıyı, adacık
ve dar geçişler o kadar iyi çözülür).

1. **Derinlik.** Bir hücrenin derinliği, o hücreyle kesişen **tüm** kaynak
   piksellerinin **en sığ** değeridir. Biri bile eksikse hücre *bilinmeyen*
   sayılır ve rota oradan geçmez. Hücre kaynak pikselinden küçükse en az bir
   piksel genişliğinde pencere taranır — ince grid derinlik güvenliğini
   gevşetmez.
2. **Kara ve engel.** OSM kıyı çizgisi yönlü taramayla kara/deniz ayrımı yapar;
   çelişkili veya kopuk bölgeler bilinmeyen kalır. Kıyıya, kayalığa, batığa,
   resife, iskeleye değen hücreler kapatılır. Bir hücreden küçük adacıklar hücre
   yarı köşegeniyle rasterlenir, yani yok olmaz.
3. **Pay.** Seçtiğiniz kıyı/engel uzaklığı kadar kare komşuluk da açık olmalıdır.
4. **Arama.** Sekiz komşulu A*; köşe kesme yok, uçlar kaydırılmaz, rota
   bulunamazsa koşullar gevşetilmez ve düz çizgiye düşülmez.
5. **Düzleştirme.** Grid merdiveni, düz çizginin geçtiği **her** hücre payıyla
   birlikte açık olduğu sürece tek bacağa indirgenir. Sonuç daha kısa ve dümen
   tutulabilir; asla merdivenden daha az güvenli değil.
6. **Bağımsız denetim.** Hem ham yol hem düzleştirilmiş bacaklar **sıfırdan
   yeniden** denetlenir: her hücre, tüm pay alanı, her geçişin iki yanı.
   Denetim geçmezse rota verilmez.

Aranan derinlik = su çekimi + omurga altı pay + model payı + su seviyesi düşüşü.

## Neye güvenilmez

- **Model gridi yaklaşık 115 m.** Dar koylar, liman girişleri ve küçük
  kayalıklar çözülmeyebilir. Bencik Koyu gibi dar koyların içi model tarafından
  sıfır derinlik okunur; uygulama bunu "çok sığ" diye değil, "model burayı
  çözemiyor" diye söyler ve rota başlatmaz. Orası gerçekte derin olabilir.
- **Canlı gelgit, rüzgâr, dalga, akıntı, AIS ve gemi trafiği yoktur.**
- **Geçici seyir yasakları ve yeni engeller** OSM'de olmayabilir.
- **İndirme tarihi, deniz tabanının ölçüldüğü tarih değildir.** Model payı
  ölçülmüş bir hata sınırı değil, sizin seçtiğiniz bir toleranstır.
- **EMODnet ve GEBCO bağımsız iki kaynak değildir**; GEBCO, EMODnet modelinin
  içindeki dolgudur. Bu sürüm hücre bazında kaynak ayrımı yapmaz.
- **Karasuları sınırı tartışmalıdır.** Ege'de Türkiye ve Yunanistan 6 mil
  uygular; bazı alanların ve adacıkların statüsü anlaşmazlık konusudur.
  Uygulamanın çizdiği sınır **OpenStreetMap'in bir yorumudur**, resmî ya da
  hukuki bir kaynak değildir ve sahil güvenlik uygulamasını bağlamaz. "Bu
  taraftan geçersen sorun çıkmaz" demez; yalnızca "OSM'ye göre sınırın bu
  tarafında kal" der.
- **Takip yalnızca uygulama ön plandayken** çalışır. Rotadan sapınca çizilen
  turuncu çizgi kontrol edilmemiş bir yöndür, rota değildir.

## Kurulum ve geliştirme

```bash
npm test          # birim testleri + gerçek veri regresyonu (ağ gerekmez)
npm run serve     # http://localhost:8787
npm run deploy    # testleri çalıştırır, gh-pages dalına yayınlar
npm run icons     # uygulama ikonlarını yeniden üretir
```

Gerçek servislerle uçtan uca deneme (internet kullanır):

```bash
node test/live.mjs --from 36.75647,28.04228 --to 36.6661,27.5105 --out evidence/deneme
```

Bağımlılık yoktur. Node 18+ ve bir tarayıcı yeterlidir.

## Dizinler

| Dizin | İçerik |
|---|---|
| `engine/` | Hesap motoru: GeoTIFF okuyucu, kıyı/engel maskesi, A*, planlayıcı |
| `web/` | Arayüz, harita, arama, seyir takibi, PWA |
| `test/` | Birim testleri, gerçek veri regresyonu, canlı deneme, yerel sunucu |
| `evidence/` | Gerçek servis çalışmalarının kanıt dosyaları |
| `ios/` | Özgün SwiftUI prototipi (0.2) — dokunulmadan saklanıyor |
| `docs/` | Yöntem notları ve GitHub Actions örneği |

## Doğrulama

Motor, iOS sürümünün C çekirdeğinden port edildi ve **kaydedilmiş gerçek servis
çalışmasını birebir üretir**: aynı kara/deniz maskesi baytları, aynı 478 hücrelik
yol, aynı 41,586 deniz mili. Birim testleri özgün C/Python takımlarından
portlandı:

- 32 GeoTIFF kodlama varyasyonu, her kesilmiş dosya, 1000 rastgele bayt dizisi
- ada / anakara / adacık / iskele maskeleri
- 300 bağımsız Dijkstra karşılaştırması
- mesafe, kerteriz, birim ve süre hesapları — geçersiz girdide değer uydurulmaz

Ayrıntı: [`docs/DOGRULAMA.md`](docs/DOGRULAMA.md).

## Yol haritası

Konuşulmuş ama henüz yapılmamış işler — çapa nöbeti, rota boyunca rüzgâr/dalga,
kalkış saati, polar tabanlı hava rotalaması, kendi iskandil kayıtları — ve
cevap bekleyen tasarım soruları: [`docs/YOL-HARITASI.md`](docs/YOL-HARITASI.md).
Bunlara ait taslak kod `taslak/capa-nobeti-ve-hava` dalında; `main`'e bağlı değil.

## Lisans

Kod [MIT](LICENSE) lisanslıdır. Kullanılan veriler kendi lisanslarına tabidir
(aşağıda) ve depoya dahil değildir.

## Kaynaklar

- [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) — derinlik modeli
- [GEBCO](https://www.gebco.net/data-products/gridded-bathymetry-data) — modelin dolgu kaynağı
- [OpenStreetMap katkıcıları](https://www.openstreetmap.org/copyright) — kıyı ve engeller, ODbL
- [OpenSeaMap](https://www.openseamap.org/) — deniz işaretleri, CC BY-SA 2.0
- [Leaflet](https://leafletjs.com/) 1.9.4, BSD-2-Clause — `web/vendor/` içinde

Harita döşemeleri yalnızca kullanıcının gerçekten görüntülediği kadarıyla
önbelleğe alınır; toplu döşeme indirilmez.
