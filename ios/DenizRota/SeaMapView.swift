import SwiftUI
import MapKit

struct CameraCommand: Equatable {
    enum Kind: Equatable { case overview, location, studyArea }
    var id = UUID()
    var kind: Kind = .overview
}

struct SeaMapView: UIViewRepresentable {
    var points: [Waypoint]
    var targetIndex: Int?
    var position: CLLocationCoordinate2D?
    var showSeamarks: Bool
    var cameraCommand: CameraCommand
    var onAddPoint: (CLLocationCoordinate2D) -> Void
    var onTileFailure: () -> Void
    var gridPreview: GridPreview? = nil
    var sparseAnnotations = false

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    private static var studyRegion: MKCoordinateRegion {
        MKCoordinateRegion(center: StudyArea.center,
                           span: .init(latitudeDelta: StudyArea.latitudeSpan,
                                       longitudeDelta: StudyArea.longitudeSpan))
    }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        // Seamark raster symbols were designed for a light base map.
        map.overrideUserInterfaceStyle = .light
        map.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        map.pointOfInterestFilter = .excludingAll
        map.isPitchEnabled = false
        map.showsCompass = true
        map.showsScale = true
        // This is an initial view, never a fabricated GPS location.
        map.setRegion(Self.studyRegion, animated: false)
        let hold = UILongPressGestureRecognizer(target: context.coordinator,
                                               action: #selector(Coordinator.longPress(_:)))
        hold.minimumPressDuration = 0.6
        map.addGestureRecognizer(hold)
        context.coordinator.map = map
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        coordinator.updateSeamarks(map)
        coordinator.updateGrid(map)
        coordinator.updateRoute(map)
        coordinator.updatePosition(map)
        if coordinator.lastCameraID != cameraCommand.id {
            coordinator.lastCameraID = cameraCommand.id
            switch cameraCommand.kind {
            case .studyArea:
                map.setRegion(Self.studyRegion, animated: true)
            case .location:
                if let position {
                    map.setRegion(MKCoordinateRegion(center: position,
                        latitudinalMeters: 4000, longitudinalMeters: 4000), animated: true)
                }
            case .overview:
                if points.isEmpty, let grid = gridPreview {
                    let b = grid.bounds
                    map.setRegion(MKCoordinateRegion(center: .init(latitude: (b.north + b.south) / 2,
                        longitude: (b.west + b.east) / 2), span: .init(latitudeDelta: (b.north - b.south) * 1.1,
                        longitudeDelta: (b.east - b.west) * 1.1)), animated: true)
                    return
                }
                guard !points.isEmpty else { return }
                var rect = MKMapRect.null
                for point in points {
                    let p = MKMapPoint(point.coordinate)
                    rect = rect.union(MKMapRect(x: p.x, y: p.y, width: 1, height: 1))
                }
                // Small routes still need useful geographic context.
                let padding = MKMapPointsPerMeterAtLatitude(points[0].latitude) * 400
                rect = rect.insetBy(dx: -padding, dy: -padding)
                map.setVisibleMapRect(rect, edgePadding: .init(top: 70, left: 45, bottom: 70, right: 45), animated: true)
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: SeaMapView
        weak var map: MKMapView?
        var lastCameraID: UUID?
        private var lastPoints: [Waypoint] = []
        private var lastTargetIndex: Int?
        private var routeLine: MKGeodesicPolyline?
        private var guidanceLine: MKGeodesicPolyline?
        private var vessel: VesselAnnotation?
        private var seamarks: SeamarkOverlay?
        private var grid: MarineGridOverlay?
        private var gridID: UUID?

        init(_ parent: SeaMapView) { self.parent = parent }

        @objc func longPress(_ gesture: UILongPressGestureRecognizer) {
            guard gesture.state == .began, parent.targetIndex == nil, let map else { return }
            let coordinate = map.convert(gesture.location(in: map), toCoordinateFrom: map)
            guard CLLocationCoordinate2DIsValid(coordinate) else { return }
            parent.onAddPoint(coordinate)
        }

        func updateSeamarks(_ map: MKMapView) {
            if parent.showSeamarks && seamarks == nil {
                let overlay = SeamarkOverlay { [weak self] in self?.parent.onTileFailure() }
                seamarks = overlay
                map.insertOverlay(overlay, at: 0, level: .aboveRoads)
            } else if !parent.showSeamarks, let existing = seamarks {
                map.removeOverlay(existing)
                seamarks = nil
            }
        }

        func updateRoute(_ map: MKMapView) {
            guard parent.points != lastPoints || parent.targetIndex != lastTargetIndex else { return }
            lastPoints = parent.points
            lastTargetIndex = parent.targetIndex
            map.removeAnnotations(map.annotations.filter { $0 is RouteAnnotation })
            map.addAnnotations(parent.points.enumerated().filter {
                !parent.sparseAnnotations || $0.offset == 0 || $0.offset == parent.points.count - 1 || $0.offset == parent.targetIndex
            }.map {
                RouteAnnotation(point: $0.element, index: $0.offset,
                                active: $0.offset == parent.targetIndex)
            })
            if let routeLine { map.removeOverlay(routeLine) }
            routeLine = nil
            if parent.points.count > 1 {
                let coordinates = parent.points.map(\.coordinate)
                let line = MKGeodesicPolyline(coordinates: coordinates, count: coordinates.count)
                routeLine = line
                map.addOverlay(line, level: .aboveLabels)
            }
        }

        func updateGrid(_ map: MKMapView) {
            guard gridID != parent.gridPreview?.id else { return }
            if let grid { map.removeOverlay(grid) }
            grid = nil; gridID = parent.gridPreview?.id
            if let preview = parent.gridPreview {
                let overlay = MarineGridOverlay(preview)
                grid = overlay
                map.addOverlay(overlay, level: .aboveRoads)
            }
        }

        func updatePosition(_ map: MKMapView) {
            if let position = parent.position {
                if let vessel { vessel.coordinate = position }
                else {
                    let annotation = VesselAnnotation(coordinate: position)
                    vessel = annotation
                    map.addAnnotation(annotation)
                }
            } else if let existing = vessel {
                map.removeAnnotation(existing)
                vessel = nil
            }
            if let guidanceLine { map.removeOverlay(guidanceLine) }
            guidanceLine = nil
            if let index = parent.targetIndex, parent.points.indices.contains(index),
               let position = parent.position {
                let coordinates = [position, parent.points[index].coordinate]
                let line = MKGeodesicPolyline(coordinates: coordinates, count: 2)
                guidanceLine = line
                map.addOverlay(line, level: .aboveLabels)
            }
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if overlay is MarineGridOverlay { return MarineGridRenderer(overlay: overlay) }
            if let tile = overlay as? MKTileOverlay { return MKTileOverlayRenderer(tileOverlay: tile) }
            if let line = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: line)
                renderer.strokeColor = line === guidanceLine ? .systemOrange : .systemTeal
                renderer.lineWidth = 4
                renderer.lineDashPattern = line === guidanceLine ? [7, 6] : [12, 5]
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if let point = annotation as? RouteAnnotation {
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: "waypoint") as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: point, reuseIdentifier: "waypoint")
                view.annotation = point
                view.markerTintColor = point.active ? .systemOrange : .systemTeal
                view.glyphText = "\(point.index + 1)"
                view.canShowCallout = true
                view.displayPriority = .required
                return view
            }
            if annotation is VesselAnnotation {
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: "vessel") as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: "vessel")
                view.annotation = annotation
                view.markerTintColor = .systemBlue
                view.glyphImage = UIImage(systemName: "location.fill")
                view.canShowCallout = true
                view.displayPriority = .required
                return view
            }
            return nil
        }
    }
}

final class RouteAnnotation: NSObject, MKAnnotation {
    let coordinate: CLLocationCoordinate2D
    let title: String?
    let subtitle: String?
    let index: Int
    let active: Bool
    init(point: Waypoint, index: Int, active: Bool) {
        coordinate = point.coordinate
        title = "\(index + 1). \(point.name)"
        subtitle = String(format: "%.5f, %.5f", point.latitude, point.longitude)
        self.index = index
        self.active = active
    }
}

final class VesselAnnotation: NSObject, MKAnnotation {
    @objc dynamic var coordinate: CLLocationCoordinate2D
    let title: String? = "Konumun"
    init(coordinate: CLLocationCoordinate2D) { self.coordinate = coordinate }
}

final class SeamarkOverlay: MKTileOverlay {
    private let onFailure: () -> Void
    init(onFailure: @escaping () -> Void) {
        self.onFailure = onFailure
        super.init(urlTemplate: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png")
        canReplaceMapContent = false
        minimumZ = 0
        maximumZ = 17
        tileSize = CGSize(width: 256, height: 256)
    }

    override func loadTile(at path: MKTileOverlayPath, result: @escaping (Data?, Error?) -> Void) {
        var request = URLRequest(url: url(forTilePath: path), cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15)
        request.setValue("DenizRota/0.1 (iOS personal prototype)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error {
                DispatchQueue.main.async { self?.onFailure() }
                result(nil, error)
                return
            }
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let data, UIImage(data: data) != nil else {
                DispatchQueue.main.async { self?.onFailure() }
                result(nil, URLError(.badServerResponse))
                return
            }
            result(data, nil)
        }.resume()
    }
}
