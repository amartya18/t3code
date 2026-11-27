@_implementationOnly import FluidAudio
import Foundation

/// Parakeet TDT 0.6B v3 on finished turns, then FluidAudio's CTC keyword spotter (Parakeet CTC 110M)
/// rescoring the transcript towards the word list. Every call runs after the one before it.
actor Transcriber {
  private var asr: AsrManager?
  private var ctc: CtcModels?
  private var words: [String] = []
  private var boost: VocabularyBoostingSession?
  private var tail: Task<Void, Never>?

  var vocabulary: [String] { words }

  func load() async throws {
    try await serial { try await self.loadNow() }
  }

  func unload() async {
    try? await serial { await self.unloadNow() }
  }

  func setVocabulary(_ words: [String]) async throws {
    try await serial { try await self.setVocabularyNow(words) }
  }

  func transcribe(_ samples: [Float]) async throws -> String {
    try await serial { try await self.transcribeNow(samples) }
  }

  private func serial<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
    let previous = tail
    let task = Task {
      await previous?.value
      return try await work()
    }
    tail = Task { _ = await task.result }
    return try await task.value
  }

  private func loadNow() async throws {
    if asr == nil {
      let models = try await AsrModels.load(from: ModelStore.asr, version: .v3)
      let manager = AsrManager(config: .default)
      try await manager.loadModels(models)
      asr = manager
    }
    if ctc == nil {
      ctc = try await CtcModels.load(from: ModelStore.ctc, variant: .ctc110m)
      try await setVocabularyNow(words)
    }
  }

  private func unloadNow() async {
    await asr?.cleanup()
    asr = nil
    ctc = nil
    boost = nil
  }

  private func setVocabularyNow(_ words: [String]) async throws {
    self.words = words
    let terms = words.map { CustomVocabularyTerm(text: $0) }
    guard let ctc, !terms.isEmpty else {
      boost = nil
      return
    }
    boost = try await VocabularyBoostingSession(vocabulary: CustomVocabularyContext(terms: terms), ctcModels: ctc)
  }

  private func transcribeNow(_ samples: [Float]) async throws -> String {
    guard let asr else { throw VoiceModeError.notStarted }
    guard !samples.isEmpty else { return "" }
    let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)
    let audio = samples + [Float](repeating: 0, count: max(0, minimum - samples.count))
    let layers = await asr.decoderLayerCount
    var state = TdtDecoderState.make(decoderLayers: layers)
    let result = try await asr.transcribe(audio, decoderState: &state)
    guard let boost, let timings = result.tokenTimings, !timings.isEmpty else { return result.text }
    let rescored = await boost.rescore(text: result.text, tokenTimings: timings, audioSamples: audio)
    return rescored?.text ?? result.text
  }
}
