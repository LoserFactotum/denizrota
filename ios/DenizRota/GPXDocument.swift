import Foundation
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let seaRouteGPX = UTType(exportedAs: "com.denizrota.route.gpx", conformingTo: .xml)
}

struct GPXDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.seaRouteGPX, .xml] }
    var text: String

    init(route: SeaRoute) {
        func escape(_ value: String) -> String {
            value.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
                .replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "'", with: "&apos;")
        }
        let points = route.points.map {
            "    <rtept lat=\"\($0.latitude)\" lon=\"\($0.longitude)\"><name>\(escape($0.name))</name></rtept>"
        }.joined(separator: "\n")
        let description: String
        if let info = route.automaticInfo {
            description = "Deneysel rota. EMODnet DTM (GEBCO dolgusu dahil); © OpenStreetMap katkıcıları, ODbL. Su çekimi \(info.boat.draft) m; model derinliği eşiği \(info.boat.minimumDepth) m. Seyir garantisi değildir."
        } else { description = "Elle çizilen rota; derinlik ve engel kontrolü yok." }
        text = """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="DenizRota" xmlns="http://www.topografix.com/GPX/1/1">
          <rte>
            <name>\(escape(route.name))</name>
            <desc>\(escape(description))</desc>
        \(points)
          </rte>
        </gpx>
        """
    }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let decoded = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadCorruptFile) }
        text = decoded
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
