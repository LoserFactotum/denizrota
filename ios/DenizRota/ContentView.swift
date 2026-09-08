import SwiftUI
import CoreLocation
import UIKit

struct ContentView: View {
    @StateObject private var location = LocationService()
    @StateObject private var store = RouteStore()
    @Environment(\.scenePhase) private var scenePhase
    @State private var route = SeaRoute()
    @State private var savedSnapshot: SeaRoute?
    @State private var targetIndex: Int?
    @State private var voyageStartedAt: Date?
    @State private var showSeamarks = true
    @State private var tileFailed = false
    @State private var camera = CameraCommand()
    @State private var showEditor = false
    @State private var showSaved = false
    @State private var showAbout = false
    @State private var alertText: String?
    @State private var pendingRoute: SeaRoute?
    @State private var confirmReplacement = false
    @State private var confirmStop = false
    @State private var recenterWhenReady = false
    @State private var showAutomatic = false
    @State private var showRouteData = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let now = timeline.date
            let fix = location.usableLocation(at: now)
            VStack(spacing: 0) {
                header
                HStack(spacing: 6) {
                    Circle().fill(fix == nil ? Color.orange : Color.green).frame(width: 7, height: 7)
                    Text(location.status(at: now)).font(.caption).lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18).padding(.bottom, 10)

                ZStack(alignment: .topLeading) {
                    SeaMapView(points: route.points, targetIndex: targetIndex,
                               position: fix?.coordinate, showSeamarks: showSeamarks,
                               cameraCommand: camera, onAddPoint: addPoint,
                               onTileFailure: { if showSeamarks && !tileFailed { tileFailed = true } },
                               sparseAnnotations: route.automaticInfo != nil)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(route.automaticInfo == nil ? "Elle çizim · Derinlik / engel kontrolü yok" : "Deneysel rota · EMODnet / GEBCO + OSM")
                            .font(.caption.weight(.semibold)).foregroundStyle(.primary)
                            .padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                        if tileFailed && showSeamarks {
                            Text("Bazı deniz işaretleri yüklenemedi")
                                .font(.caption).padding(8)
                                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                        }
                    }.padding(10).padding(.trailing, 45)
                }
                .overlay(alignment: .trailing) { mapControls(fix: fix).padding(10) }
                .overlay(alignment: .bottomLeading) {
                    if showSeamarks {
                        Link("© OpenSeaMap / OpenStreetMap", destination: URL(string: "https://www.openseamap.org/index.php?L=1&id=faq")!)
                            .font(.system(size: 10)).foregroundStyle(.primary)
                            .padding(5).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
                            .padding(.leading, 10).padding(.bottom, 28)
                    }
                }
                .frame(minHeight: 160, maxHeight: .infinity)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let index = targetIndex { navigationPanel(index: index, fix: fix, now: now) }
                        else { planningPanel(fix: fix, now: now) }
                    }.padding(18)
                }
                .frame(maxHeight: targetIndex == nil ? 325 : 360)
                .background(Color(uiColor: .systemBackground))
            }
            .background(Color(uiColor: .systemBackground))
            .sheet(isPresented: $showEditor) { RouteEditorView(route: $route) }
            .sheet(isPresented: $showSaved) {
                SavedRoutesView(store: store) { replacement in
                    // Wait for the sheet to dismiss before presenting a discard alert.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { propose(replacement) }
                }
            }
            .sheet(isPresented: $showAbout) { AboutView() }
            .sheet(isPresented: $showAutomatic) {
                AutomaticRouteView(route: route) { calculated, _ in
                    route = calculated
                    camera = CameraCommand(kind: .overview)
                }
            }
            .sheet(isPresented: $showRouteData) {
                NavigationStack {
                    List { if let info = route.automaticInfo { RouteDataSection(info: info) } }
                        .navigationTitle("Rota verisi")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Bitti") { showRouteData = false } } }
                }
            }
            .alert("DenizRota", isPresented: Binding(get: { alertText != nil }, set: { if !$0 { alertText = nil } })) {
                Button("Tamam") { alertText = nil }
            } message: { Text(alertText ?? "") }
            .alert("Kaydedilmemiş değişiklikler var", isPresented: $confirmReplacement) {
                Button("Vazgeç", role: .cancel) { pendingRoute = nil }
                Button("Kaydetmeden devam et", role: .destructive) { replaceRoute() }
            } message: { Text("Mevcut rotadaki değişiklikler kaybolacak.") }
            .alert("Seyir takibi bitirilsin mi?", isPresented: $confirmStop) {
                Button("Vazgeç", role: .cancel) { }
                Button("Bitir", role: .destructive) { stopNavigation() }
            }
            .onChange(of: scenePhase) { _, phase in
                location.setForeground(phase == .active)
                UIApplication.shared.isIdleTimerDisabled = targetIndex != nil && phase == .active
            }
            .onChange(of: fix != nil) { _, ready in
                if ready && recenterWhenReady {
                    recenterWhenReady = false
                    camera = CameraCommand(kind: .location)
                }
            }
            .onChange(of: fix?.timestamp) { _, _ in
                // Automatic routes advance at their next point, never by snapping to a
                // distant later leg. This prevents skipping a headland or obstacle.
                if route.automaticInfo != nil, let index = targetIndex, let fix,
                   route.points.indices.contains(index),
                   NavigationMath.distance(fix.coordinate, route.points[index].coordinate) <= 50 {
                    if index + 1 < route.points.count { targetIndex = index + 1 }
                    else { stopNavigation(); alertText = "Planlanan varış noktasına ulaşıldı." }
                }
            }
            .onChange(of: store.errorMessage) { _, message in
                if let message { alertText = message; store.errorMessage = nil }
            }
            .onAppear {
                if let message = store.errorMessage { alertText = message; store.errorMessage = nil }
            }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: "sailboat.fill").font(.title2).foregroundStyle(.teal)
                Text("DenizRota").font(.title2.bold()).foregroundStyle(.primary)
            }
            Spacer()
            if targetIndex == nil {
                Menu {
                    Button("Rotalarım", systemImage: "folder") { showSaved = true }
                    Button("Yeni rota", systemImage: "plus") { propose(SeaRoute()) }
                    Button("Marmaris · Datça · Bodrum", systemImage: "map") {
                        camera = CameraCommand(kind: .studyArea)
                    }
                } label: { Image(systemName: "folder").frame(width: 44, height: 44) }
                    .accessibilityLabel("Rota dosyaları")
            }
            Button { showAbout = true } label: {
                Image(systemName: "info.circle").frame(width: 44, height: 44)
            }.accessibilityLabel("Uygulama bilgileri")
        }.padding(.horizontal, 18).padding(.top, 4)
    }

    private func mapControls(fix: CLLocation?) -> some View {
        VStack(spacing: 8) {
            Button {
                location.request()
                if fix != nil { camera = CameraCommand(kind: .location) }
                else { recenterWhenReady = true }
            } label: { Image(systemName: "location.fill").frame(width: 44, height: 44) }
                .accessibilityLabel("Konumuma git")
            Button { camera = CameraCommand(kind: .overview) } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
            }.accessibilityLabel("Rotanın tamamını göster").disabled(route.points.isEmpty)
            Button {
                showSeamarks.toggle()
                tileFailed = false
            } label: {
                Image(systemName: "square.3.layers.3d")
                    .foregroundStyle(showSeamarks ? Color.teal : Color.secondary).frame(width: 44, height: 44)
            }.accessibilityLabel(showSeamarks ? "Deniz işaretlerini gizle" : "Deniz işaretlerini göster")
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private func planningPanel(fix: CLLocation?, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(route.name).font(.headline).lineLimit(1)
                    Text(route.points.isEmpty ? "Başlangıç ve varış için haritada basılı tut" : (route.automaticInfo == nil ? "\(route.points.count) nokta · Elle çizilen rota" : "Derinlik ve engellere göre hesaplandı"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Düzenle") { showEditor = true }.font(.subheadline.weight(.semibold))
            }
            HStack {
                Button("Otomatik rota", systemImage: "point.topleft.down.to.point.bottomright.curvepath") { showAutomatic = true }
                    .buttonStyle(.bordered).disabled(route.points.count < 2)
                if route.automaticInfo != nil {
                    Button("Veri ayrıntıları", systemImage: "info.circle") { showRouteData = true }.font(.caption)
                }
            }
            HStack(alignment: .top, spacing: 8) {
                metric("MESAFE", value: Display.nauticalMiles(route.distanceMeters), unit: "deniz mili")
                metric("TAHMİNİ SÜRE", value: route.points.count > 1 ? Display.duration(route.plannedSeconds) : "—")
                metric("ŞİMDİ ÇIKARSAN", value: route.points.count > 1 ? Display.arrival(after: route.plannedSeconds, now: now) : "—")
            }
            HStack {
                Text("Planlanan hız").font(.subheadline)
                Spacer()
                Text("\(Display.number(route.plannedSpeedKnots)) kn").font(.subheadline.monospacedDigit().bold())
                Stepper("Planlanan hız", value: $route.plannedSpeedKnots, in: 0.5...60, step: 0.5).labelsHidden()
            }
            Text("İlk noktadan son noktaya, sabit hızla. Rüzgâr, akıntı ve molalar dahil değil.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button {
                    if store.save(route) { savedSnapshot = route; alertText = "Rota kaydedildi." }
                } label: { Image(systemName: "square.and.arrow.down").frame(width: 28, height: 28) }
                    .buttonStyle(.bordered).disabled(route.points.isEmpty).accessibilityLabel("Rotayı kaydet")
                Button {
                    if let fix {
                        route.points.insert(Waypoint(name: "Başlangıç konumum",
                            latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude), at: 0)
                    }
                } label: { Image(systemName: "location.badge.plus").frame(width: 28, height: 28) }
                    .buttonStyle(.bordered).disabled(fix == nil).accessibilityLabel("Konumumu ilk nokta yap")
                Button {
                    guard fix != nil, !route.points.isEmpty else { return }
                    targetIndex = 0
                    voyageStartedAt = .now
                    UIApplication.shared.isIdleTimerDisabled = true
                } label: {
                    Label("Takibi başlat", systemImage: "location.north.line.fill")
                        .font(.subheadline.bold()).frame(maxWidth: .infinity, minHeight: 28)
                }
                .buttonStyle(.borderedProminent).disabled(fix == nil || route.points.isEmpty)
            }
        }
    }

    private func navigationPanel(index: Int, fix: CLLocation?, now: Date) -> some View {
        let target = route.points[index]
        let speed = location.speedMPS(at: now)
        let knots = dn_knots_from_mps(speed)
        let remaining = fix.map { NavigationMath.remainingDistance(from: $0.coordinate, route: route, targetIndex: index) } ?? .nan
        let targetDistance = fix.map { NavigationMath.distance($0.coordinate, target.coordinate) } ?? .nan
        let bearing = fix.map { NavigationMath.bearing($0.coordinate, target.coordinate) } ?? .nan
        // Suppress unstable ETA near rest. Never replace live speed with planned speed.
        let eta = knots.isFinite && knots >= 0.5 ? dn_eta_seconds(remaining, speed) : .nan
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(index + 1)/\(route.points.count) · \(target.name)").font(.headline)
                    Text("Hedefe \(Display.nauticalMiles(targetDistance)) deniz mili · Kerteriz \(Display.bearing(bearing)) gerçek")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "sailboat.fill").font(.title).foregroundStyle(.teal)
            }
            HStack(alignment: .top, spacing: 8) {
                metric("KALAN MESAFE", value: Display.nauticalMiles(remaining), unit: "deniz mili")
                metric("GPS HIZI", value: Display.number(knots), unit: "knot · yer hızı")
                metric("KALAN SÜRE", value: Display.duration(eta))
            }
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("TAHMİNİ VARIŞ").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(Display.arrival(after: eta, now: now)).font(.title3.monospacedDigit().bold())
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    Text("GEÇEN SÜRE").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(Display.duration(max(0, now.timeIntervalSince(voyageStartedAt ?? now))))
                        .font(.subheadline.monospacedDigit())
                }
            }
            Text(eta.isFinite ? "Varış hesabı, mevcut GPS hızının sürmesine bağlıdır. Uygulama açıkken takip eder."
                 : "Süre hesabı için güncel GPS ve en az 0,5 knot ölçülen hız gerekiyor.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Bitir", role: .destructive) { confirmStop = true }.buttonStyle(.bordered)
                Button {
                    if index + 1 < route.points.count { targetIndex = index + 1 }
                    else { stopNavigation(); alertText = "Son noktaya ulaştığını işaretledin. Seyir takibi tamamlandı." }
                } label: {
                    Text(index + 1 < route.points.count ? "Noktaya ulaştım →" : "Varışa ulaştım")
                        .frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent)
                    .disabled(fix == nil || !targetDistance.isFinite || targetDistance > 50)
            }
            Text(route.automaticInfo == nil ? "Sonraki noktaya geçiş, hedefe 50 m içinde ve senin onayınla açılır." : "Hedefe 50 m içinde sıradaki noktaya geçer. Turuncu çizgi yalnızca hedef yönüdür; rotadan sapınca yeni geçiş kontrolü yapılmaz.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func metric(_ title: String, value: String, unit: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
            Text(value).font(.system(.title3, design: .rounded, weight: .bold)).monospacedDigit()
                .minimumScaleFactor(0.65).lineLimit(2)
            if let unit { Text(unit).font(.caption2).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func addPoint(_ coordinate: CLLocationCoordinate2D) {
        guard targetIndex == nil else { return }
        route.points.append(Waypoint(name: "Nokta \(route.points.count + 1)",
                                     latitude: coordinate.latitude, longitude: coordinate.longitude))
    }
    private func propose(_ replacement: SeaRoute) {
        guard targetIndex == nil else { return }
        pendingRoute = replacement
        if !route.points.isEmpty && route != savedSnapshot { confirmReplacement = true }
        else { replaceRoute() }
    }
    private func replaceRoute() {
        guard targetIndex == nil, let pendingRoute else { return }
        route = pendingRoute
        savedSnapshot = store.routes.first { $0.id == route.id }
        self.pendingRoute = nil
        camera = CameraCommand(kind: .overview)
    }
    private func stopNavigation() {
        targetIndex = nil
        voyageStartedAt = nil
        UIApplication.shared.isIdleTimerDisabled = false
    }
}
