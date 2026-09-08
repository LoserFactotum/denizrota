import SwiftUI
import MapKit

struct GridReviewView: View {
    let preview: GridPreview
    let points: [Waypoint]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                SeaMapView(points: points, targetIndex: nil, position: nil, showSeamarks: true,
                    cameraCommand: CameraCommand(kind: .overview), onAddPoint: { _ in }, onTileFailure: {},
                    gridPreview: preview, sparseAnnotations: true)
                VStack(alignment: .leading, spacing: 8) {
                    HStack { legend(.teal, "Derinlik uygun"); legend(.orange, "Sığ") }
                    HStack { legend(.red, "Kıyı / engel"); legend(.gray, "Veri bilinmiyor") }
                    Text("Renkler hesap hücrelerini gösterir. Ek kıyı/engel uzaklığı rota aramasında uygulanır. Bilinmeyen hücrelerden rota geçirilmez.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding().background(.regularMaterial)
            }
            .navigationTitle("Hesaplanan alan").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Bitti") { dismiss() } } }
        }
    }
    private func legend(_ color: Color, _ title: String) -> some View {
        HStack { Circle().fill(color).frame(width: 9, height: 9); Text(title).font(.caption) }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

final class MarineGridOverlay: NSObject, MKOverlay {
    let coordinate: CLLocationCoordinate2D
    let boundingMapRect: MKMapRect
    let image: CGImage?
    init(_ preview: GridPreview) {
        let b = preview.bounds
        coordinate = CLLocationCoordinate2D(latitude: (b.north + b.south) / 2, longitude: (b.west + b.east) / 2)
        let nw = MKMapPoint(CLLocationCoordinate2D(latitude: b.north, longitude: b.west))
        let se = MKMapPoint(CLLocationCoordinate2D(latitude: b.south, longitude: b.east))
        boundingMapRect = MKMapRect(x: nw.x, y: nw.y, width: se.x - nw.x, height: se.y - nw.y)
        // Render on a Mercator-aligned raster; routing itself uses the metric grid.
        var rgba = [UInt8](repeating: 0, count: b.count * 4)
        for row in 0..<b.rows {
            let y = nw.y + (Double(row) + 0.5) / Double(b.rows) * (se.y - nw.y)
            let latitude = MKMapPoint(x: nw.x, y: y).coordinate.latitude
            let sourceRow = min(b.rows - 1, max(0, Int((b.north - latitude) * b.metersPerLatitudeDegree / b.cell)))
            for col in 0..<b.columns {
                let value = preview.cells[sourceRow * b.columns + col]
                let c: [UInt8]
                switch value {
                case 1: c = [0, 150, 160, 45]
                case 2: c = [0, 0, 0, 0]
                case 4: c = [210, 40, 50, 130]
                case 8: c = [245, 145, 0, 130]
                default: c = [90, 90, 100, 155]
                }
                let offset = (row * b.columns + col) * 4
                for k in 0..<4 { rgba[offset + k] = c[k] }
            }
        }
        if let provider = CGDataProvider(data: Data(rgba) as CFData) {
            image = CGImage(width: b.columns, height: b.rows, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: b.columns * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        } else { image = nil }
        super.init()
    }
}

final class MarineGridRenderer: MKOverlayRenderer {
    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let grid = overlay as? MarineGridOverlay, let image = grid.image else { return }
        let destination = rect(for: grid.boundingMapRect)
        context.saveGState()
        context.interpolationQuality = .none
        context.translateBy(x: destination.minX, y: destination.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: destination.size))
        context.restoreGState()
    }
}
