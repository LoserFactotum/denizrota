import Foundation
import CoreLocation
import CryptoKit

struct BoatProfile: Codable, Equatable {
    var draft = 1.5
    var underKeel = 1.0
    var modelAllowance = 5.0
    var waterLevelDrop = 0.0
    var horizontalBuffer = 150.0
    var minimumDepth: Double { draft + underKeel + modelAllowance + waterLevelDrop }
    var isValid: Bool {
        draft.isFinite && (0.1...15).contains(draft)
        && underKeel.isFinite && (0...10).contains(underKeel)
        && modelAllowance.isFinite && (0...50).contains(modelAllowance)
        && waterLevelDrop.isFinite && (0...10).contains(waterLevelDrop)
        && horizontalBuffer.isFinite && (0...2000).contains(horizontalBuffer)
    }
}

struct MarineCoordinate: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    init(_ point: Waypoint) { latitude = point.latitude; longitude = point.longitude }
}

struct AutomaticRouteInfo: Codable, Equatable {
    let calculatedAt: Date
    let bathymetryDownloadedAt: Date
    let osmDownloadedAt: Date
    let osmDatabaseTimestamp: String
    let boat: BoatProfile
    let cellMeters: Double
    let sourceLatitudeStep: Double
    let minimumModelDepth: Double
    let obstacleCount: Int
    let unknownCellCount: Int
    let totalCellCount: Int
    let anchors: [Waypoint]
    let geometry: [MarineCoordinate]
    let bathymetryURL: String
    let osmQuery: String
    let bathymetrySHA256: String
    let osmSHA256: String
    static let sourceLabel = "EMODnet DTM · GEBCO dolgusu dahil"
}

struct MarineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct PlanningBounds {
    let west: Double
    let south: Double
    let rows: Int
    let columns: Int
    let cell = 150.0
    let metersPerLatitudeDegree = 6_371_000.0 * .pi / 180
    let metersPerLongitudeDegree: Double
    var east: Double { west + Double(columns) * cell / metersPerLongitudeDegree }
    var north: Double { south + Double(rows) * cell / metersPerLatitudeDegree }
    var count: Int { rows * columns }
    // Slightly larger downloads ensure every planning cell has full source coverage.
    var downloadBBox: String { [west - 0.01, south - 0.01, east + 0.01, north + 0.01].map { String($0) }.joined(separator: ",") }
    var overpassBBox: String { [south - 0.01, west - 0.01, north + 0.01, east + 0.01].map { String($0) }.joined(separator: ",") }

    init(anchors: [Waypoint]) throws {
        guard (2...20).contains(anchors.count), anchors.allSatisfy(\.isValid),
              anchors.allSatisfy({ (36.2...37.4).contains($0.latitude) && (26.8...28.8).contains($0.longitude) }) else {
            throw MarineError("Marmaris–Datça–Bodrum bölgesinde 2–20 rota noktası seç.")
        }
        let minLat = anchors.map(\.latitude).min()!, maxLat = anchors.map(\.latitude).max()!
        let minLon = anchors.map(\.longitude).min()!, maxLon = anchors.map(\.longitude).max()!
        metersPerLongitudeDegree = metersPerLatitudeDegree * cos((minLat + maxLat) / 2 * .pi / 180)
        west = floor((minLon - 0.18) * 20) / 20
        south = floor((minLat - 0.18) * 20) / 20
        columns = Int(ceil((ceil((maxLon + 0.18) * 20) / 20 - west) * metersPerLongitudeDegree / cell))
        rows = Int(ceil((ceil((maxLat + 0.18) * 20) / 20 - south) * metersPerLatitudeDegree / cell))
        guard rows > 0, columns > 0, rows * columns <= 1_000_000 else {
            throw MarineError("Bu rota tek hesaplama için çok geniş. Daha kısa etaplar seç.")
        }
    }
    func project(latitude: Double, longitude: Double) -> DMPoint {
        DMPoint(x: (longitude - west) * metersPerLongitudeDegree, y: (latitude - south) * metersPerLatitudeDegree)
    }
    func waypoint(at index: Int, name: String) -> Waypoint {
        Waypoint(name: name,
            latitude: south + (Double(rows - 1 - index / columns) + 0.5) * cell / metersPerLatitudeDegree,
            longitude: west + (Double(index % columns) + 0.5) * cell / metersPerLongitudeDegree)
    }
    func index(_ point: Waypoint) throws -> Int {
        var result = 0
        guard dm_cell_index(rows, columns, cell, project(latitude: point.latitude, longitude: point.longitude), &result) != 0 else {
            throw MarineError("Rota noktası indirilen alanın dışında.")
        }
        return result
    }
}

struct GridPreview {
    let id = UUID()
    let bounds: PlanningBounds
    // 0 unknown, 1 available by model, 2 land, 4 mapped obstacle/coast, 8 shallow.
    let cells: [UInt8]
}

struct PreparedMarineGrid {
    let bounds: PlanningBounds
    let depths: [Double]
    let flags: [UInt8]
    let preview: GridPreview
    let bathymetryDate: Date
    let osmDate: Date
    let osmTimestamp: String
    let obstacles: Int
    let unknown: Int
    let sourceStep: Double
    let bathymetryURL: String
    let osmQuery: String
    let bathymetrySHA256: String
    let osmSHA256: String
}

private struct CachedPayload {
    let data: Data
    let downloadedAt: Date
}
private struct CacheStamp: Codable { let downloadedAt: Date }

actor MarineDataService {
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 100
        c.timeoutIntervalForResource = 150
        return URLSession(configuration: c)
    }()
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func fetch(_ request: URLRequest) async throws -> CachedPayload {
        try Task.checkCancellation()
        let fm = FileManager.default
        let directory = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("MarineSources-v1")
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = Self.digest(Data((request.url!.absoluteString).utf8) + (request.httpBody ?? Data()))
        let file = directory.appendingPathComponent(key + ".data")
        let stampFile = directory.appendingPathComponent(key + ".json")
        if let data = try? Data(contentsOf: stampFile), let stamp = try? JSONDecoder().decode(CacheStamp.self, from: data),
           (0..<86400).contains(Date().timeIntervalSince(stamp.downloadedAt)), let payload = try? Data(contentsOf: file) {
            return CachedPayload(data: payload, downloadedAt: stamp.downloadedAt)
        }
        var request = request
        request.setValue("DenizRota/0.2 (iOS experimental route planner)", forHTTPHeaderField: "User-Agent")
        let (temporary, response) = try await session.download(for: request)
        defer { try? fm.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw MarineError("\(request.url!.host ?? "Veri servisi") yanıt vermedi (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)). Tekrar deneyebilirsin.")
        }
        let attributes = try fm.attributesOfItem(atPath: temporary.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= 80_000_000 else {
            throw MarineError("Veri yanıtı boş veya indirme sınırını aşıyor.")
        }
        let data = try Data(contentsOf: temporary)
        let date = Date()
        // Network success alone does not certify content; prepare() always validates it.
        // Avoid persisting obvious XML/HTML error responses as numeric/JSON data.
        let jsonError = data.first == 123 && ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["remark"] != nil)
        if data.first != 60 && !jsonError {
            try? data.write(to: file, options: .atomic)
            try? JSONEncoder().encode(CacheStamp(downloadedAt: date)).write(to: stampFile, options: .atomic)
        }
        trimCache(directory)
        return CachedPayload(data: data, downloadedAt: date)
    }

    private func trimCache(_ directory: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        let dated = files.filter { $0.pathExtension == "json" }.compactMap { file -> (URL, Date)? in
            guard let d = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(CacheStamp.self, from: d) else { return nil }
            return (file, s.downloadedAt)
        }.sorted { $0.1 > $1.1 }
        for (file, _) in dated.dropFirst(8) {
            try? fm.removeItem(at: file.deletingPathExtension().appendingPathExtension("data"))
            try? fm.removeItem(at: file)
        }
    }

    func prepare(anchors: [Waypoint], boat: BoatProfile,
                 progress: @Sendable (String) async -> Void) async throws -> PreparedMarineGrid {
        guard boat.isValid else { throw MarineError("Tekne ölçülerini kontrol et.") }
        let bounds = try PlanningBounds(anchors: anchors)
        var url = URLComponents(string: "https://ows.emodnet-bathymetry.eu/wcs")!
        url.queryItems = ["service": "WCS", "version": "1.0.0", "request": "GetCoverage",
            "coverage": "emodnet:mean", "crs": "EPSG:4326", "bbox": bounds.downloadBBox,
            "format": "GeoTIFF", "interpolation": "nearest", "resx": String(1.0 / 960),
            "resy": String(1.0 / 960), "compression": "NONE"].sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        await progress("EMODnet / GEBCO derinlik modeli indiriliyor…")
        let bathy = try await fetch(URLRequest(url: url.url!))
        var raster = DMRaster()
        let result = bathy.data.withUnsafeBytes {
            dm_read_geotiff($0.bindMemory(to: UInt8.self).baseAddress, $0.count, &raster)
        }
        guard result == 0 else { throw MarineError("Sayısal derinlik dosyası okunamadı (GeoTIFF \(result)). Rota üretilmedi.") }
        defer { dm_free_raster(&raster) }
        // Reject accidental low-resolution responses instead of hiding a source change.
        guard raster.dx <= 1.0 / 900, raster.dy <= 1.0 / 900 else {
            throw MarineError("Derinlik servisinin çözünürlüğü beklenen gridle uyuşmuyor.")
        }
        await progress("OpenStreetMap kıyı, kayalık, batık ve engelleri indiriliyor…")
        let b = bounds.overpassBBox
        let query = """
        [out:json][timeout:90];(
        way["natural"="coastline"](\(b));
        nwr["seamark:type"~"^(rock|wreck|obstruction|restricted_area|military_area|marine_farm)$"](\(b));
        nwr["man_made"~"^(pier|breakwater|groyne)$"](\(b));
        nwr["natural"="reef"](\(b));
        );out body geom;
        """
        var request = URLRequest(url: URL(string: "https://overpass-api.de/api/interpreter")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "data", value: query)]
        request.httpBody = form.percentEncodedQuery!.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        let osm = try await fetch(request)
        let features = try OSMFeatures(data: osm.data, bounds: bounds)
        await progress("Kıyı sınırları, sığlıklar ve engeller hesaplanıyor…")
        try Task.checkCancellation()
        var mask = [UInt8](repeating: 0, count: bounds.count)
        let maskResult = features.coast.withUnsafeBufferPointer { segments in
            mask.withUnsafeMutableBufferPointer {
                dm_coast_mask(bounds.rows, bounds.columns, bounds.cell, segments.baseAddress, segments.count, $0.baseAddress)
            }
        }
        guard maskResult == 0 else { throw MarineError("Kıyı sınırı oluşturulamadı (\(maskResult)).") }
        for shape in features.obstacles {
            try Task.checkCancellation()
            shape.points.withUnsafeBufferPointer { points in
                mask.withUnsafeMutableBufferPointer {
                    dm_block_shape(bounds.rows, bounds.columns, bounds.cell, points.baseAddress, points.count, shape.fill ? 1 : 0, $0.baseAddress)
                }
            }
        }
        var depths = [Double](repeating: .nan, count: bounds.count)
        var flags = [UInt8](repeating: 0, count: bounds.count)
        var unknown = 0
        for row in 0..<bounds.rows {
            if row % 32 == 0 { try Task.checkCancellation() }
            let north = bounds.north - Double(row) * bounds.cell / bounds.metersPerLatitudeDegree
            let south = north - bounds.cell / bounds.metersPerLatitudeDegree
            for col in 0..<bounds.columns {
                let i = row * bounds.columns + col
                if mask[i] == 0 { unknown += 1; continue }
                if mask[i] != 1 { flags[i] = UInt8(DR_LAND); continue }
                let west = bounds.west + Double(col) * bounds.cell / bounds.metersPerLongitudeDegree
                let depth = dm_min_depth(&raster, west, south, west + bounds.cell / bounds.metersPerLongitudeDegree, north)
                if !depth.isFinite { mask[i] = 0; unknown += 1; continue }
                depths[i] = depth
                flags[i] = UInt8(DR_COVERED)
                if depth < boat.minimumDepth { mask[i] = 8 }
            }
        }
        guard flags.contains(UInt8(DR_COVERED)) else { throw MarineError("İndirilen alanda kullanılabilir deniz/derinlik verisi bulunamadı.") }
        return PreparedMarineGrid(bounds: bounds, depths: depths, flags: flags,
            preview: GridPreview(bounds: bounds, cells: mask), bathymetryDate: bathy.downloadedAt,
            osmDate: osm.downloadedAt, osmTimestamp: features.timestamp, obstacles: features.obstacles.count,
            unknown: unknown, sourceStep: raster.dy, bathymetryURL: url.url!.absoluteString, osmQuery: query,
            bathymetrySHA256: Self.digest(bathy.data), osmSHA256: Self.digest(osm.data))
    }

    func route(grid: PreparedMarineGrid, anchors: [Waypoint], boat: BoatProfile,
               original: SeaRoute) throws -> SeaRoute {
        try Task.checkCancellation()
        let b = grid.bounds
        // Model allowance is a user-selected planning margin, not a measured uncertainty.
        let uncertainty = [Double](repeating: 0, count: b.count)
        var vessel = DRVessel(draft_m: boat.draft, under_keel_clearance_m: boat.underKeel,
            dynamic_allowance_m: boat.modelAllowance, water_level_lower_m: -boat.waterLevelDrop,
            horizontal_buffer_m: boat.horizontalBuffer)
        var allPoints = [anchors[0]], minimumDepth = Double.infinity
        for (a, z) in zip(anchors, anchors.dropFirst()) {
            try Task.checkCancellation()
            let start = try b.index(a), goal = try b.index(z)
            var path = [Int](repeating: 0, count: b.count)
            let result = grid.depths.withUnsafeBufferPointer { depths in
                uncertainty.withUnsafeBufferPointer { uncertainties in
                    grid.flags.withUnsafeBufferPointer { flags in
                        var cGrid = DRGrid(rows: b.rows, columns: b.columns, cell_size_m: b.cell,
                            charted_depth_m: depths.baseAddress, depth_uncertainty_m: uncertainties.baseAddress, flags: flags.baseAddress)
                        return path.withUnsafeMutableBufferPointer { dr_plan(&cGrid, &vessel, start, goal, $0.baseAddress, $0.count) }
                    }
                }
            }
            guard result.status == DR_OK else {
                switch result.status {
                case DR_START_BLOCKED, DR_GOAL_BLOCKED:
                    let point = result.status == DR_START_BLOCKED ? a : z
                    throw MarineError("‘\(point.name)’ noktası sığlık, kıyı/engel payı veya eksik veri alanında. Haritada farklı bir başlangıç/varış seç; nokta kendiliğinden başka yere taşınmadı.")
                case DR_NO_ROUTE:
                    throw MarineError("Seçilen derinlik ve uzaklık koşullarıyla indirilen alanda rota bulunamadı. Ara etap ekleyerek arama alanını değiştirebilirsin.")
                default: throw MarineError("Rota hesabı tamamlanamadı (\(result.status.rawValue)).")
                }
            }
            let indexes = Array(path.prefix(result.count))
            for i in indexes { minimumDepth = min(minimumDepth, grid.depths[i]) }
            // Only collapse consecutive equal grid directions. No corner-cutting smoothing.
            var keep: [Int] = []
            for i in indexes.indices {
                if i == 0 || i == indexes.count - 1 || i % 8 == 0 { keep.append(indexes[i]); continue }
                let previous = indexes[i - 1], current = indexes[i], next = indexes[i + 1]
                if current / b.columns - previous / b.columns != next / b.columns - current / b.columns
                    || current % b.columns - previous % b.columns != next % b.columns - current % b.columns {
                    keep.append(current)
                }
            }
            // Exact anchors connect to centres of their own fully checked cells.
            allPoints += keep.map { b.waypoint(at: $0, name: "Rota dönüşü") }
            allPoints.append(z)
        }
        try Task.checkCancellation()
        var points: [Waypoint] = []
        for p in allPoints {
            if let last = points.last, NavigationMath.distance(last.coordinate, p.coordinate) < 0.1 { continue }
            var point = p
            // Repeated via positions still need independent stable UI identities.
            point.id = UUID()
            points.append(point)
        }
        var route = original
        route.points = points
        route.automatic = AutomaticRouteInfo(calculatedAt: .now,
            bathymetryDownloadedAt: grid.bathymetryDate, osmDownloadedAt: grid.osmDate,
            osmDatabaseTimestamp: grid.osmTimestamp, boat: boat, cellMeters: b.cell,
            sourceLatitudeStep: grid.sourceStep, minimumModelDepth: minimumDepth,
            obstacleCount: grid.obstacles, unknownCellCount: grid.unknown, totalCellCount: b.count,
            anchors: anchors, geometry: points.map(MarineCoordinate.init),
            bathymetryURL: grid.bathymetryURL, osmQuery: grid.osmQuery,
            bathymetrySHA256: grid.bathymetrySHA256, osmSHA256: grid.osmSHA256)
        return route
    }
}

private struct OSMShape { let points: [DMPoint]; let fill: Bool }
private struct OSMFeatures {
    let coast: [DMSegment]
    let obstacles: [OSMShape]
    let timestamp: String

    init(data: Data, bounds: PlanningBounds) throws {
        guard let document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let elements = document["elements"] as? [[String: Any]], elements.count < 100_000,
              document["remark"] == nil else { throw MarineError("OpenStreetMap yanıtı eksik veya zaman aşımına uğradı. Engel verisi tamamlanmadan rota oluşturulmaz.") }
        timestamp = (document["osm3s"] as? [String: Any])?["timestamp_osm_base"] as? String ?? "Tarih belirtilmedi"
        func coordinate(_ p: [String: Any]) throws -> DMPoint {
            guard let lat = p["lat"] as? Double, let lon = p["lon"] as? Double,
                  lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon) else {
                throw MarineError("Engel/kıyı verisinde eksik koordinat var.")
            }
            return bounds.project(latitude: lat, longitude: lon)
        }
        func geometry(_ e: [String: Any]) throws -> [DMPoint] {
            if e["type"] as? String == "node" { return [try coordinate(e)] }
            guard let g = e["geometry"] as? [[String: Any]], !g.isEmpty else { throw MarineError("Harita nesnesinin geometrisi eksik.") }
            return try g.map(coordinate)
        }
        var segments: [DMSegment] = [], shapes: [OSMShape] = []
        // Every internal coastline node must have exactly one incoming and outgoing edge.
        var balance: [Int64: (incoming: Int, outgoing: Int, p: DMPoint)] = [:]
        for e in elements {
            let tags = e["tags"] as? [String: String] ?? [:]
            if tags["natural"] == "coastline" {
                let g = try geometry(e)
                guard let nodes = e["nodes"] as? [Int64], nodes.count == g.count, g.count >= 2 else { throw MarineError("Kıyı verisi birleştirilemiyor.") }
                for i in 1..<g.count {
                    segments.append(DMSegment(a: g[i - 1], b: g[i]))
                    var a = balance[nodes[i - 1]] ?? (0, 0, g[i - 1]); a.outgoing += 1; balance[nodes[i - 1]] = a
                    var z = balance[nodes[i]] ?? (0, 0, g[i]); z.incoming += 1; balance[nodes[i]] = z
                }
            } else if e["type"] as? String == "relation" {
                guard let members = e["members"] as? [[String: Any]] else { throw MarineError("Engel alanının üyeleri eksik.") }
                // Assemble outer ways; inner holes remain blocked conservatively.
                var pieces = try members.filter { ($0["role"] as? String) != "inner" }.map(geometry)
                while !pieces.isEmpty {
                    var ring = pieces.removeFirst()
                    func equal(_ a: DMPoint, _ b: DMPoint) -> Bool { hypot(a.x - b.x, a.y - b.y) < 0.01 }
                    while ring.count > 1 && !equal(ring.first!, ring.last!) {
                        guard let i = pieces.firstIndex(where: { equal($0.first!, ring.last!) || equal($0.last!, ring.last!) }) else {
                            throw MarineError("Engel alanı kapatılamadı; eksik alanı boş deniz saymamak için hesap durdu.")
                        }
                        var part = pieces.remove(at: i)
                        if equal(part.last!, ring.last!) { part.reverse() }
                        ring.append(contentsOf: part.dropFirst())
                    }
                    shapes.append(OSMShape(points: ring, fill: ring.count >= 4))
                }
            } else {
                let g = try geometry(e)
                let closed = g.count >= 4 && hypot(g.first!.x - g.last!.x, g.first!.y - g.last!.y) < 0.01
                shapes.append(OSMShape(points: g, fill: closed))
            }
        }
        guard !segments.isEmpty, segments.count <= 300_000 else { throw MarineError("Bu alanın kıyı verisi alınamadı.") }
        for (_, node) in balance {
            if node.p.x > 0 && node.p.x < Double(bounds.columns) * bounds.cell
                && node.p.y > 0 && node.p.y < Double(bounds.rows) * bounds.cell
                && (node.incoming != 1 || node.outgoing != 1) {
                throw MarineError("İndirilen alan içinde kopuk veya çakışan kıyı çizgisi var. Hesap tamamlanamadı.")
            }
        }
        coast = segments
        obstacles = shapes
    }
}
