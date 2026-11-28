@_implementationOnly import FluidAudio
import Foundation

struct VocabularyTerm: Equatable, Sendable {
  let text: String
  let aliases: [String]
  let minSimilarity: Double?

  init(text: String, aliases: [String] = [], minSimilarity: Double? = nil) {
    self.text = text
    self.aliases = aliases
    self.minSimilarity = minSimilarity
  }

  init(_ record: VocabularyTermRecord) {
    self.init(text: record.text, aliases: record.aliases, minSimilarity: record.minSimilarity)
  }
}

struct Transcript: Sendable {
  struct Swap: Sendable {
    let from: String
    let to: String
  }

  let text: String
  let replaced: [Swap]
}

/// Calls are serialized.
actor Transcriber {
  private var asr: AsrManager?
  private var ctc: CtcModels?
  private var terms: [VocabularyTerm] = []
  private var boost: VocabularyBoostingSession?
  private var tail: Task<Void, Never>?

  var vocabulary: [VocabularyTerm] { terms }

  func load() async throws {
    try await serial { try await self.loadNow() }
  }

  func unload() async {
    try? await serial { await self.unloadNow() }
  }

  func setVocabulary(_ terms: [VocabularyTerm]) async throws {
    try await serial { try await self.setVocabularyNow(terms) }
  }

  func transcribe(_ samples: [Float]) async throws -> Transcript {
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
      try await setVocabularyNow(terms)
    }
  }

  private func unloadNow() async {
    await asr?.cleanup()
    asr = nil
    ctc = nil
    boost = nil
  }

  private func setVocabularyNow(_ terms: [VocabularyTerm]) async throws {
    self.terms = terms
    guard let ctc, !terms.isEmpty else {
      boost = nil
      return
    }
    let context = CustomVocabularyContext(
      terms: terms.map {
        CustomVocabularyTerm(
          text: $0.text, aliases: $0.aliases.isEmpty ? nil : $0.aliases, minSimilarity: $0.minSimilarity.map(Float.init))
      },
      // FluidAudio skips terms under 3 characters by default, which would drop "T3".
      minTermLength: 2)
    boost = try await VocabularyBoostingSession(vocabulary: context, ctcModels: ctc)
  }

  private func transcribeNow(_ samples: [Float]) async throws -> Transcript {
    guard let asr else { throw VoiceModeError.notStarted }
    guard !samples.isEmpty else { return Transcript(text: "", replaced: []) }
    let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)
    let audio = samples + [Float](repeating: 0, count: max(0, minimum - samples.count))
    let layers = await asr.decoderLayerCount
    var state = TdtDecoderState.make(decoderLayers: layers)
    let result = try await asr.transcribe(audio, decoderState: &state)
    guard let boost, let timings = result.tokenTimings, !timings.isEmpty,
      let rescored = await boost.rescore(text: result.text, tokenTimings: timings, audioSamples: audio)
    else { return Transcript(text: result.text, replaced: []) }
    let replaced = rescored.replacements.compactMap { swap -> Transcript.Swap? in
      guard swap.shouldReplace, let to = swap.replacementWord else { return nil }
      return Transcript.Swap(from: swap.originalWord, to: to)
    }
    return Transcript(text: rescored.text, replaced: replaced)
  }
}
