import Foundation
import CoreLocation

enum StudyArea {
    static let name = "Marmaris · Datça · Bodrum"
    // Camera framing chosen for the user's study area. Not chart coverage,
    // territorial boundaries, verified waypoints or a navigable polygon.
    static let center = CLLocationCoordinate2D(latitude: 36.82, longitude: 27.70)
    static let latitudeSpan = 1.0
    static let longitudeSpan = 1.8
}

struct Waypoint: Identifiable, Codable, Equatable {
    var id = UUID()
    var name: String
    var latitude: Double
    var longitude: Double

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
    var isValid: Bool {
        latitude.isFinite && longitude.isFinite
            && (-90...90).contains(latitude) && (-180...180).contains(longitude)
    }
}

struct SeaRoute: Identifiable, Codable, Equatable {
    var id = UUID()
    var name = "Yeni rota"
    var points: [Waypoint] = []
    var plannedSpeedKnots = 5.0
    var automatic: AutomaticRouteInfo?
    // Old saved routes decode with nil; editing geometry invalidates its provenance.
    var automaticInfo: AutomaticRouteInfo? {
        guard let automatic, automatic.boat.isValid, automatic.minimumModelDepth.isFinite,
              automatic.cellMeters.isFinite, automatic.cellMeters > 0,
              (2...20).contains(automatic.anchors.count), automatic.anchors.allSatisfy(\.isValid),
              automatic.geometry == points.map(MarineCoordinate.init) else { return nil }
        return automatic
    }

    var distanceMeters: Double { NavigationMath.routeDistance(points) }
    var plannedSeconds: Double {
        dn_eta_seconds(distanceMeters, dn_mps_from_knots(plannedSpeedKnots))
    }
    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && plannedSpeedKnots.isFinite && (0.5...60).contains(plannedSpeedKnots)
            && points.allSatisfy(\.isValid)
            && Set(points.map(\.id)).count == points.count
    }
}

enum NavigationMath {
    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        dn_distance_m(a.latitude, a.longitude, b.latitude, b.longitude)
    }
    static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        dn_initial_bearing_deg(a.latitude, a.longitude, b.latitude, b.longitude)
    }
    static func routeDistance(_ points: [Waypoint]) -> Double {
        zip(points, points.dropFirst()).reduce(0) {
            $0 + distance($1.0.coordinate, $1.1.coordinate)
        }
    }
    static func remainingDistance(from position: CLLocationCoordinate2D,
                                  route: SeaRoute, targetIndex: Int) -> Double {
        guard route.points.indices.contains(targetIndex) else { return .nan }
        let remainder = Array(route.points.dropFirst(targetIndex))
        return distance(position, remainder[0].coordinate) + routeDistance(remainder)
    }
}

enum Display {
    static func number(_ value: Double, decimals: Int = 1) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(.number.precision(.fractionLength(decimals)))
    }
    static func nauticalMiles(_ meters: Double) -> String { number(meters / 1852, decimals: 2) }
    static func bearing(_ degrees: Double) -> String {
        guard degrees.isFinite else { return "—" }
        return String(format: "%03d°", Int(degrees.rounded()) % 360)
    }
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0, seconds < 315_360_000 else { return "—" }
        if seconds == 0 { return "0 dk" }
        if seconds < 60 { return "<1 dk" }
        let minutes = Int(ceil(seconds / 60))
        let hours = minutes / 60
        return hours > 0 ? "\(hours) sa \(minutes % 60) dk" : "\(minutes) dk"
    }
    static func arrival(after seconds: Double, now: Date = .now) -> String {
        guard seconds.isFinite, seconds >= 0, seconds < 315_360_000 else { return "—" }
        let date = now.addingTimeInterval(seconds)
        if Calendar.current.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
