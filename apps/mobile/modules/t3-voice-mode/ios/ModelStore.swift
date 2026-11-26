import FluidAudio
import Foundation

/// Every model lives under one directory we own, so status, size and delete agree with FluidAudio's loaders.
enum ModelStore {
  static let base: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("T3VoiceMode", isDirectory: true)
  static let root = base.appendingPathComponent("Models", isDirectory: true)
  static let tts = root.appendingPathComponent(Repo.kokoroAne.folderName, isDirectory: true)

  static func requiredFiles(_ config: VoiceConfig) -> [URL] {
    var ttsFiles = ModelNames.KokoroAne.requiredModels
    ttsFiles.insert("\(config.voiceId).bin")
    if config.vocoderFloat32 { ttsFiles.insert(ModelNames.KokoroAne.vocoderFloat32) }
    let sets: [(Repo, Set<String>)] = [
      (.vad, ModelNames.VAD.requiredModels),
      (config.asrRepo, ModelNames.ParakeetEOU.requiredModels),
      (.kokoroAne, ttsFiles),
      (.kokoro, ModelNames.G2P.requiredModels),
    ]
    return sets.flatMap { repo, names in
      names.map { root.appendingPathComponent(repo.folderName).appendingPathComponent($0) }
    }
  }

  static func status(_ config: VoiceConfig) -> [String: Any] {
    let files = requiredFiles(config)
    let present = files.filter { FileManager.default.fileExists(atPath: $0.path) }.count
    let state = present == files.count ? "ready" : present == 0 ? "missing" : "partial"
    return ["state": state, "bytesOnDisk": bytesOnDisk()]
  }

  static func isReady(_ config: VoiceConfig) -> Bool {
    requiredFiles(config).allSatisfy { FileManager.default.fileExists(atPath: $0.path) }
  }

  static func bytesOnDisk() -> Int {
    guard let files = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
    else { return 0 }
    var total = 0
    for case let url as URL in files {
      total += (try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey]).totalFileAllocatedSize) ?? 0
    }
    return total
  }

  static func download(_ config: VoiceConfig, progress: @escaping @Sendable (String, Double) -> Void) async throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    var baseURL = base
    try baseURL.setResourceValues(excluded)

    try await ModelHub.download(.vad, to: root) { progress("vad", $0.fractionCompleted) }
    try await ModelHub.download(config.asrRepo, to: root) { progress("asr", $0.fractionCompleted) }
    try await KokoroAneResourceDownloader.ensureModels(
      variant: .english, directory: root,
      additionalModelNames: config.vocoderFloat32 ? [ModelNames.KokoroAne.vocoderFloat32] : []
    ) { progress("tts", $0.fractionCompleted) }
    try await KokoroAneResourceDownloader.ensureG2PAssets(directory: root)
    _ = await KokoroAneResourceDownloader.ensureEnglishLexicon(directory: root)
    try await KokoroAneResourceDownloader.ensureVoicePack(config.voiceId, repoDirectory: tts)
    progress("tts", 1)
  }

  static func delete() throws {
    guard FileManager.default.fileExists(atPath: base.path) else { return }
    try FileManager.default.removeItem(at: base)
  }
}
