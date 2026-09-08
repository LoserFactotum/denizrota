import SwiftUI

@MainActor
final class AutomaticPlanner: ObservableObject {
    @Published var busy = false
    @Published var progress = ""
    @Published var error: String?
    @Published var preview: GridPreview?
    @Published var result: SeaRoute?
    private let service = MarineDataService()
    private var task: Task<Void, Never>?

    func calculate(_ original: SeaRoute, boat: BoatProfile) {
        guard !busy else { return }
        busy = true; error = nil; result = nil; preview = nil
        let anchors = original.automaticInfo?.anchors ?? original.points
        task = Task {
            defer { busy = false }
            do {
                let grid = try await service.prepare(anchors: anchors, boat: boat) { [weak self] message in
                    await MainActor.run { self?.progress = message }
                }
                try Task.checkCancellation()
                preview = grid.preview
                progress = "Derinlik ve engellere göre rota aranıyor…"
                let route = try await service.route(grid: grid, anchors: anchors, boat: boat, original: original)
                try Task.checkCancellation()
                result = route
                progress = "Rota hesaplandı"
            } catch is CancellationError {
                progress = "Hesap iptal edildi"
            } catch {
                if Task.isCancelled { progress = "Hesap iptal edildi" }
                else { self.error = error.localizedDescription }
            }
        }
    }
    func cancel() { task?.cancel() }
}

struct AutomaticRouteView: View {
    let route: SeaRoute
    var onApply: (SeaRoute, GridPreview?) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var planner = AutomaticPlanner()
    @State private var boat = BoatProfile()
    @State private var showGrid = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Otomatik rota · Deneysel") {
                    let anchors = route.automaticInfo?.anchors ?? route.points
                    Text("\(anchors.first?.name ?? "Başlangıç") → \(anchors.last?.name ?? "Varış")")
                        .font(.headline)
                    if anchors.count > 2 { Text("\(anchors.count - 2) ara noktadan geçer.") }
                    Text("Haritada işaretlediğin noktalar arasında, aşağıdaki koşulları sağlayan geçişleri arar.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Teknem ve paylar") {
                    measurement("Su çekimi", value: $boat.draft, range: 0.1...15, step: 0.1)
                    measurement("Omurga altında pay", value: $boat.underKeel, range: 0...10, step: 0.1)
                    measurement("Ek model payı", value: $boat.modelAllowance, range: 0...50, step: 0.5)
                    measurement("Su seviyesi düşüş payı", value: $boat.waterLevelDrop, range: 0...10, step: 0.1)
                    measurement("Kıyı ve engel uzaklığı", value: $boat.horizontalBuffer, range: 0...2000, step: 50)
                    LabeledContent("Aranan model derinliği", value: "≥ \(Display.number(boat.minimumDepth)) m")
                    Text("Ölçüler başlangıç değerleridir; kendi teknen için değiştir. Ek model payı seçtiğin bir toleranstır, verinin ölçülmüş hata sınırı değildir. Uzaklık, 150 m hücrelere yukarı yuvarlanır.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(planner.busy)
                Section("Veriler") {
                    Text(AutomaticRouteInfo.sourceLabel)
                    Text("Kıyı ve engeller: © OpenStreetMap katkıcıları. Harita işaretleri: OpenSeaMap.")
                    Text("EMODnet grid aralığı yaklaşık 115 m; GEBCO dolgusunun kaynak aralığı daha geniştir. Küçük kayalıklar ve dar liman girişleri bu modelde çözülemeyebilir. Güncel harita ve gözle kontrol ederek kullan.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    if planner.busy {
                        HStack { ProgressView(); Text(planner.progress).font(.subheadline) }
                        Button("Hesabı iptal et", role: .cancel) { planner.cancel() }
                    } else {
                        Button("Derinlik ve engellere göre hesapla", systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
                            planner.calculate(route, boat: boat)
                        }.disabled(!boat.isValid)
                    }
                    if let error = planner.error { Text(error).foregroundStyle(.orange) }
                    if planner.preview != nil {
                        Button("Hesaplanan alanı incele", systemImage: "map") { showGrid = true }
                    }
                }
                if let result = planner.result, let info = result.automaticInfo {
                    Section("Sonuç") {
                        LabeledContent("Mesafe", value: "\(Display.nauticalMiles(result.distanceMeters)) deniz mili")
                        LabeledContent("Tahmini süre", value: Display.duration(result.plannedSeconds))
                        LabeledContent("Planlanan hız", value: "\(Display.number(result.plannedSpeedKnots)) knot")
                        LabeledContent("En sığ model hücresi", value: "\(Display.number(info.minimumModelDepth)) m")
                        Text("Bu derinlik, indirilmiş modelin değeridir; güncel iskandil ölçümü değildir.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Bu rotayı kullan", systemImage: "checkmark.circle.fill") {
                            onApply(result, planner.preview); dismiss()
                        }.fontWeight(.semibold)
                    }
                    RouteDataSection(info: info)
                }
            }
            .navigationTitle("Otomatik rota").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Kapat") { planner.cancel(); dismiss() } } }
            .onAppear { boat = route.automaticInfo?.boat ?? BoatProfile() }
            .onChange(of: boat) { _, _ in planner.result = nil; planner.preview = nil }
            .onDisappear { planner.cancel() }
            .sheet(isPresented: $showGrid) {
                if let preview = planner.preview {
                    GridReviewView(preview: preview, points: planner.result?.points ?? [])
                }
            }
        }
    }
    private func measurement(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double) -> some View {
        Stepper(value: value, in: range, step: step) {
            HStack { Text(title); Spacer(); Text("\(Display.number(value.wrappedValue)) m").monospacedDigit() }
        }
    }
}

struct RouteDataSection: View {
    let info: AutomaticRouteInfo
    var body: some View {
        Section("Rota verisi") {
            Text(AutomaticRouteInfo.sourceLabel)
            LabeledContent("Derinlik indirildi", value: info.bathymetryDownloadedAt.formatted(date: .abbreviated, time: .shortened))
            LabeledContent("Engel verisi indirildi", value: info.osmDownloadedAt.formatted(date: .abbreviated, time: .shortened))
            LabeledContent("Engel geometrisi", value: "\(info.obstacleCount)")
            LabeledContent("Bilinmeyen hücre", value: "\(info.unknownCellCount) / \(info.totalCellCount)")
            LabeledContent("Hesap hücresi", value: "\(Display.number(info.cellMeters, decimals: 0)) m")
            Text("Kaynaklar bağımsız doğrulama sağlamaz: EMODnet modeli GEBCO dolgusu içerir. Bu sürüm hücre bazında kaynak ayrımı yapmaz. İndirme tarihi, ölçüm tarihi değildir.")
                .font(.footnote).foregroundStyle(.secondary)
            Link("EMODnet veri açıklaması", destination: URL(string: "https://emodnet.ec.europa.eu/en/bathymetry")!)
            Link("GEBCO veri açıklaması", destination: URL(string: "https://www.gebco.net/data-products/gridded-bathymetry-data")!)
        }
    }
}
