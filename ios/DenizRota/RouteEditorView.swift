import SwiftUI

struct RouteEditorView: View {
    @Binding var route: SeaRoute
    @Environment(\.dismiss) private var dismiss
    @State private var addingCoordinate = false
    @State private var exporting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Rota") {
                    TextField("Rota adı", text: $route.name)
                    LabeledContent("Toplam mesafe", value: "\(Display.nauticalMiles(route.distanceMeters)) deniz mili")
                    LabeledContent("Tahmini süre", value: route.points.count > 1 ? Display.duration(route.plannedSeconds) : "—")
                    Text("Süre, noktalar arasındaki çizgilerin toplam uzunluğuna ve seçtiğin hıza göre hesaplanır.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    ForEach($route.points) { $point in
                        VStack(alignment: .leading, spacing: 5) {
                            TextField("Nokta adı", text: $point.name)
                            Text(String(format: "%.5f, %.5f", point.latitude, point.longitude))
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { route.points.remove(atOffsets: $0) }
                    .onMove { route.points.move(fromOffsets: $0, toOffset: $1) }
                    Button("Koordinat ile nokta ekle", systemImage: "plus.circle") { addingCoordinate = true }
                } header: {
                    Text("Rota noktaları · \(route.points.count)")
                } footer: {
                    Text("Haritada basılı tutarak da nokta ekleyebilirsin. İlk nokta planlanan başlangıçtır. Seyir takibi önce bu noktaya yön gösterir.")
                }
                Section {
                    Button("Rotayı GPX olarak dışa aktar", systemImage: "square.and.arrow.up") { exporting = true }
                        .disabled(route.points.isEmpty)
                }
            }
            .navigationTitle("Rotayı düzenle")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) { Button("Bitti") { dismiss() } }
            }
            .sheet(isPresented: $addingCoordinate) {
                CoordinateEntryView { route.points.append($0) }
            }
            .fileExporter(isPresented: $exporting, document: GPXDocument(route: route),
                          contentType: .seaRouteGPX, defaultFilename: "DenizRota.gpx") { result in
                if case .failure(let failure) = result { error = failure.localizedDescription }
            }
            .alert("Dışa aktarılamadı", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("Tamam") { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}

struct CoordinateEntryView: View {
    var onAdd: (Waypoint) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var latitude = ""
    @State private var longitude = ""

    private var point: Waypoint? {
        func parse(_ text: String) -> Double? {
            Double(text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "."))
        }
        guard let lat = parse(latitude), let lon = parse(longitude) else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = Waypoint(name: trimmed.isEmpty ? "Rota noktası" : trimmed, latitude: lat, longitude: lon)
        return candidate.isValid ? candidate : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nokta adı", text: $name)
                TextField("Enlem (ör. 36,7)", text: $latitude).keyboardType(.numbersAndPunctuation)
                TextField("Boylam (ör. 28,1)", text: $longitude).keyboardType(.numbersAndPunctuation)
                Text("Ondalık derece gir. Güney enlemi ve batı boylamı için eksi işareti kullan.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle("Koordinat ekle").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ekle") { if let point { onAdd(point); dismiss() } }.disabled(point == nil)
                }
            }
        }
    }
}

struct SavedRoutesView: View {
    @ObservedObject var store: RouteStore
    var onLoad: (SeaRoute) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var toDelete: SeaRoute?

    var body: some View {
        NavigationStack {
            List {
                if store.routes.isEmpty {
                    ContentUnavailableView("Henüz kayıtlı rota yok", systemImage: "map",
                                           description: Text("Hazırladığın rotayı ana ekrandan kaydedebilirsin."))
                }
                ForEach(store.routes) { route in
                    Button {
                        onLoad(route)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(route.name).font(.headline)
                            Text("\(route.points.count) nokta · \(Display.nauticalMiles(route.distanceMeters)) deniz mili · \(Display.duration(route.plannedSeconds))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions { Button("Sil", role: .destructive) { toDelete = route } }
                }
            }
            .navigationTitle("Rotalarım")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Bitti") { dismiss() } } }
            .alert("Rota silinsin mi?", isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } })) {
                Button("Vazgeç", role: .cancel) { toDelete = nil }
                Button("Sil", role: .destructive) { if let toDelete { store.delete(toDelete) }; toDelete = nil }
            } message: { Text(toDelete?.name ?? "") }
        }
    }
}
