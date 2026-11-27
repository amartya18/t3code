import CryptoKit
@_implementationOnly import FluidAudio
import Foundation

/// Every model lives under one directory we own, so status, size and delete agree with FluidAudio's loaders.
enum ModelStore {
  static let base: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("T3VoiceMode", isDirectory: true)
  static let root = base.appendingPathComponent("Models", isDirectory: true)
  static let asr = root.appendingPathComponent(Repo.parakeetV3.folderName, isDirectory: true)
  static let ctc = root.appendingPathComponent(Repo.parakeetCtc110m.folderName, isDirectory: true)
  static let tts = root.appendingPathComponent(Repo.kokoroAne.folderName, isDirectory: true)
  static let vadModel = root.appendingPathComponent(Repo.vad.folderName, isDirectory: true)
    .appendingPathComponent(sileroFrameModel)
  static let turnModel = root.appendingPathComponent("smart-turn-v3.2", isDirectory: true)
    .appendingPathComponent("smart_turn.mlmodelc", isDirectory: true)

  /// FluidAudio's VadManager loads only the 256 ms model, which ORs eight frames together.
  private static let sileroFrameModel = "silero-vad-unified-v6.0.0.mlmodelc"
  private static let retiredFolders = ["parakeet-eou-streaming"]

  private static let turnRepo = "https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML/resolve/75f069717f500947195fa1945c46ddb472559cff/smart_turn.mlmodelc/"
  private static let turnFiles: [(path: String, sha256: String)] = [
    ("coremldata.bin", "9245ac99889c9d738cba6c89da9e851fd16488bf8effbc15a109d06b401c9383"),
    ("analytics/coremldata.bin", "1646746d0029e78d26be065e62602d4f89e51013ec238b653adf7d7d21057f89"),
    ("model.mil", "41a6d9ac0f7d01d738e56ecdf4435e55f139591541b7cf1a4dba6b9ce2f1c9ef"),
    ("weights/weight.bin", "b6295316741a0149e1fcab7cdf030e1b9bfb0eef778207accee91a2a9703a39c"),
  ]

  static func requiredFiles(_ config: VoiceConfig) -> [URL] {
    var ttsFiles = ModelNames.KokoroAne.requiredModels
    ttsFiles.insert("\(config.voiceId).bin")
    if config.vocoderFloat32 { ttsFiles.insert(ModelNames.KokoroAne.vocoderFloat32) }
    let sets: [(Repo, Set<String>)] = [
      (.parakeetV3, ModelNames.ASR.requiredModelsV3().union([ModelNames.ASR.vocabularyFile])),
      (.parakeetCtc110m, ModelNames.CTC.requiredFiles.union(["tokenizer.json"])),
      (.kokoroAne, ttsFiles),
      (.kokoro, ModelNames.G2P.requiredModels),
    ]
    let fluid = sets.flatMap { repo, names in
      names.map { root.appendingPathComponent(repo.folderName).appendingPathComponent($0) }
    }
    return [vadModel, turnModel] + fluid
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
    for folder in retiredFolders { try? FileManager.default.removeItem(at: root.appendingPathComponent(folder)) }

    try await ModelHub.download(.vad, to: root, additionalModelNames: [sileroFrameModel]) {
      progress("vad", $0.fractionCompleted)
    }
    try await AsrModels.download(to: asr, version: .v3) { progress("asr", 0.8 * $0.fractionCompleted) }
    try await CtcModels.download(to: ctc, variant: .ctc110m) { progress("asr", 0.8 + 0.2 * $0.fractionCompleted) }
    try await downloadTurnModel { progress("turn", $0) }
    try await KokoroAneResourceDownloader.ensureModels(
      variant: .english, directory: root,
      additionalModelNames: config.vocoderFloat32 ? [ModelNames.KokoroAne.vocoderFloat32] : []
    ) { progress("tts", $0.fractionCompleted) }
    try await KokoroAneResourceDownloader.ensureG2PAssets(directory: root)
    _ = await KokoroAneResourceDownloader.ensureEnglishLexicon(directory: root)
    try await KokoroAneResourceDownloader.ensureVoicePack(config.voiceId, repoDirectory: tts)
    progress("tts", 1)
  }

  /// Smart Turn isn't a FluidAudio model: fetched from a pinned HF commit, renamed into place only after every file verifies.
  private static func downloadTurnModel(progress: @escaping @Sendable (Double) -> Void) async throws {
    guard !FileManager.default.fileExists(atPath: turnModel.path) else { return progress(1) }
    let staging = turnModel.deletingLastPathComponent().appendingPathComponent("staging", isDirectory: true)
    try? FileManager.default.removeItem(at: staging)
    defer { try? FileManager.default.removeItem(at: staging) }
    for (index, file) in turnFiles.enumerated() {
      progress(Double(index) / Double(turnFiles.count))
      let (temporary, response) = try await URLSession.shared.download(from: URL(string: turnRepo + file.path)!)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let data = try Data(contentsOf: temporary, options: .mappedIfSafe)
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard status == 200, digest == file.sha256 else {
        throw VoiceModeError.make("download_failed", "Smart Turn \(file.path) failed its check (HTTP \(status)).")
      }
      let destination = staging.appendingPathComponent(file.path)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.moveItem(at: temporary, to: destination)
    }
    try FileManager.default.moveItem(at: staging, to: turnModel)
    progress(1)
  }

  static func delete() throws {
    guard FileManager.default.fileExists(atPath: base.path) else { return }
    try FileManager.default.removeItem(at: base)
  }
}
