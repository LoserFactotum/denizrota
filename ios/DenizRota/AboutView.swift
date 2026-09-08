import SwiftUI

struct AboutView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("İlk çalışma bölgesi") {
                    Text(StudyArea.name)
                    Text("Otomatik rota bu bölgedeki başlangıç, ara nokta ve varışlar için hesaplanır.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("DenizRota · 0.2") {
                    Text("Haritada basılı tutarak başlangıç ve varış ekle. Otomatik rota düğmesine bas, tekne ölçülerini gir ve hesapla. Sonucu inceleyip Bu rotayı kullan seçeneğine dokun. Planlanan hızı knot olarak ayarla; mesafeyi, süreyi ve varış saatini gör.")
                    Text("1 knot = saatte 1 deniz mili. Örnek: 12 deniz mili / 6 knot = 2 saat.")
                    Text("Konum okuna dokunup izin ver. GPS hazır olunca kendi konumunu ilk nokta olarak ekleyebilir veya takibi başlatabilirsin.")
                }
                Section("Rota ve süre") {
                    Text("Otomatik rota, EMODnet’in GEBCO dolgusu içeren derinlik modeliyle OSM kıyı ve engellerini birlikte kullanır. Renkli veri görünümünde sığlıklar, engeller ve bilinmeyen hücreleri inceleyebilirsin. Elle çizimde bu kontrol yapılmaz.")
                    Text("Derinlikler model değerleridir. Küçük kayalıklar, dar geçişler, yeni engeller ve geçici kısıtlamalar eksik olabilir. Güncel deniz haritası ve gözlemle kontrol ederek kullan. Rota bulunamazsa koşullar otomatik gevşetilmez.")
                    Text("Planlama süresi, ilk ve son rota noktaları arasındaki toplam mesafe / seçilen hızdır. Konumundan ilk noktaya olan mesafe ancak seyir takibinde kalan mesafeye eklenir.")
                    Text("Seyirde kalan süre güncel GPS yer hızına göre hesaplanır. Hız 0,5 knot altında, konum eski veya doğruluğu yetersiz olduğunda süre gösterilmez. Hız, rüzgâr, akıntı ve molalar varış saatini değiştirebilir.")
                    Text("Kerteriz gerçek kuzeye göredir; manyetik pusula açısı veya teknenin baş açısı değildir. Mesafeler küresel Dünya modeliyle yaklaşık hesaplanır.")
                }
                Section("Bağlantı ve konum") {
                    Text("Harita ve ilk veri indirmesi internet ister. Aynı alanın derinlik/engel dosyaları 24 saat önbellekten kullanılabilir; çevrimdışı harita paketi yoktur. Kaydettiğin rota, tekne ayarları ve veri tarihleri cihazda kalır.")
                    Text("Konum takibi yalnızca uygulama öndeyken çalışır. Ekran kilitlenirse veya başka uygulamaya geçersen takip durur; geri döndüğünde yeni GPS ölçümü beklenir.")
                    Text("Hesap, abonelik, reklam ve analiz servisi yoktur. Harita istekleri Apple ve OpenSeaMap’e; rota alanının sınırları EMODnet ve Overpass’a gider. Uygulamanın kendi sunucusu yoktur.")
                }
                Section("Harita kaynakları") {
                    Link("Derinlik: EMODnet Bathymetry", destination: URL(string: "https://emodnet.ec.europa.eu/en/bathymetry")!)
                    Link("Model dolgu kaynağı: GEBCO", destination: URL(string: "https://www.gebco.net/data-products/gridded-bathymetry-data")!)
                    Text("GEBCO bu sürümde EMODnet modelinin içinde kullanılır; ayrı bir GEBCO servisi çağrılmaz. Hücre bazında kaynak ayrımı henüz yoktur. İndirme tarihi ölçüm tarihi değildir.")
                    Link("Temel harita: Apple MapKit", destination: URL(string: "https://developer.apple.com/maps/")!)
                    Link("Deniz işaretleri: © OpenSeaMap / OpenStreetMap katkıcıları", destination: URL(string: "https://www.openseamap.org/index.php?L=1&id=faq")!)
                    Link("OpenSeaMap harita döşemeleri: CC BY-SA 2.0", destination: URL(string: "https://creativecommons.org/licenses/by-sa/2.0/")!)
                    Link("OpenStreetMap verisi: ODbL", destination: URL(string: "https://www.openstreetmap.org/copyright")!)
                    Text("Deniz işaretlerinin eksiksizliği ve güncelliği doğrulanmamıştır; boş alan, tehlike bulunmadığı anlamına gelmez.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Nasıl kullanılır?").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Bitti") { dismiss() } } }
        }
    }
}
