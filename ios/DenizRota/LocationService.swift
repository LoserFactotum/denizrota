import Foundation
import CoreLocation
import Combine

final class LocationService: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var location: CLLocation?
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var preciseLocation = true
    @Published private(set) var message: String?
    private let manager = CLLocationManager()
    private var requested = false
    private var foreground = true

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
        authorization = manager.authorizationStatus
        preciseLocation = manager.accuracyAuthorization == .fullAccuracy
    }

    func request() {
        requested = true
        message = nil
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            if foreground { manager.startUpdatingLocation() }
        case .denied, .restricted: message = "Konum izni kapalı. Ayarlar’dan izin verebilirsin."
        @unknown default: message = "Konum izni durumu alınamadı."
        }
    }

    func setForeground(_ value: Bool) {
        foreground = value
        if value && requested { request() }
        if !value {
            manager.stopUpdatingLocation()
            location = nil
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
        preciseLocation = manager.accuracyAuthorization == .fullAccuracy
        if authorization == .denied || authorization == .restricted {
            location = nil
            manager.stopUpdatingLocation()
        }
        if requested { request() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let candidate = locations.last,
              CLLocationCoordinate2DIsValid(candidate.coordinate),
              candidate.horizontalAccuracy.isFinite, candidate.horizontalAccuracy >= 0 else { return }
        location = candidate
        message = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        message = "Konum alınamıyor. Açık gökyüzünde tekrar dene."
        location = nil
    }

    func usableLocation(at now: Date) -> CLLocation? {
        guard preciseLocation, let location,
              location.horizontalAccuracy <= 50,
              (0...15).contains(now.timeIntervalSince(location.timestamp)) else { return nil }
        return location
    }

    func speedMPS(at now: Date) -> Double {
        guard let fix = usableLocation(at: now), fix.speed.isFinite, fix.speed >= 0,
              fix.speedAccuracy.isFinite, fix.speedAccuracy >= 0,
              fix.speedAccuracy <= 1.5,
              fix.speedAccuracy <= max(0.3, fix.speed * 0.5) else { return .nan }
        return fix.speed
    }

    func status(at now: Date) -> String {
        if let message { return message }
        if authorization == .notDetermined { return "Konum için sağdaki oka dokun" }
        if authorization == .denied || authorization == .restricted { return "Konum izni kapalı" }
        if !preciseLocation { return "Ayarlar’dan Kesin Konum’u aç" }
        if let fix = usableLocation(at: now) { return "GPS · ±\(Int(ceil(fix.horizontalAccuracy))) m" }
        return "Güncel ve yeterli doğrulukta GPS bekleniyor"
    }
}
