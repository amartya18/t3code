import Foundation

struct DiagnosticStore: Sendable {
  static let maxBytes = 2 * 1024 * 1024
  static let maxFiles = 20
  static let shared = DiagnosticStore(
    directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("diagnostics", isDirectory: true))

  let directory: URL

  func save(_ json: Data, now: Date = Date()) {
    guard !json.isEmpty, json.count <= Self.maxBytes else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let stamp = String(format: "%013lld", Int64(now.timeIntervalSince1970 * 1000))
    try? json.write(to: file("\(stamp)-\(UUID().uuidString.prefix(8))"), options: .atomic)
    for stale in ids().dropLast(Self.maxFiles) {
      try? FileManager.default.removeItem(at: file(stale))
    }
  }

  /// Oldest first.
  func pending() -> [[String: String]] {
    ids().compactMap { id in
      guard let data = try? Data(contentsOf: file(id)), data.count <= Self.maxBytes,
            let json = String(data: data, encoding: .utf8) else { return nil }
      return ["id": id, "json": json]
    }
  }

  func remove(_ id: String) {
    guard ids().contains(id) else { return }
    try? FileManager.default.removeItem(at: file(id))
  }

  private func ids() -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
  }

  private func file(_ id: String) -> URL {
    directory.appendingPathComponent("\(id).json")
  }
}
