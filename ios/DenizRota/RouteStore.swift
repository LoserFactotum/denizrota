import Foundation
import Combine

final class RouteStore: ObservableObject {
    @Published private(set) var routes: [SeaRoute] = []
    @Published var errorMessage: String?
    private let fileURL: URL

    init() {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = folder.appendingPathComponent("routes-v1.json")
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let decoded = try JSONDecoder().decode([SeaRoute].self, from: Data(contentsOf: fileURL))
            guard decoded.allSatisfy(\.isValid), Set(decoded.map(\.id)).count == decoded.count else {
                throw CocoaError(.fileReadCorruptFile)
            }
            routes = decoded
        } catch {
            // Never silently replace an unreadable route file with an empty one.
            errorMessage = "Kayıtlı rotalar okunamadı. Dosyanın üzerine yazılmadı."
            isWritable = false
        }
    }

    private var isWritable = true

    @discardableResult
    func save(_ route: SeaRoute) -> Bool {
        guard route.isValid, !route.points.isEmpty else {
            errorMessage = "Rota için geçerli bir ad, hız ve en az bir nokta gerekiyor."
            return false
        }
        var next = routes
        if let index = next.firstIndex(where: { $0.id == route.id }) { next[index] = route }
        else { next.append(route) }
        return commit(next)
    }

    func delete(_ route: SeaRoute) {
        _ = commit(routes.filter { $0.id != route.id })
    }

    private func commit(_ next: [SeaRoute]) -> Bool {
        guard isWritable else {
            errorMessage = "Rota dosyası okunamadığı için kayıt kapalı. Önce mevcut dosyayı kurtarın."
            return false
        }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(next).write(to: fileURL, options: .atomic)
            routes = next
            return true
        } catch {
            errorMessage = "Rota kaydedilemedi: \(error.localizedDescription)"
            return false
        }
    }
}
