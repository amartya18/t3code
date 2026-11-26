import AVFoundation
import CoreML
@_implementationOnly import FluidAudio
import Foundation

/// Parakeet streaming ASR plus Silero VAD. One loop consumes every command in order, so a finalize
/// always sees exactly the audio that arrived before it.
actor Listener {
  enum Command {
    case audio(AVAudioPCMBuffer)
    case reset
    case finalize(CheckedContinuation<String, Error>)
  }

  nonisolated let input: AsyncStream<Command>.Continuation
  private let events: EventSink
  private var asr: StreamingEouAsrManager?
  private var asrChunk: StreamingChunkSize?
  private var asrDebounceMs: Int?
  private var vadModel: MLModel?
  private var vad: VadManager?
  private var settings = VadSettings(threshold: 0.5, minSpeechSamples: 0, minSilenceSeconds: 0.75)
  private var segmentation = VadSegmentationConfig()
  private var vadState = VadStreamState.initial()
  private var pending: [Float] = []
  private var speechStart: Int?
  private var reported = false

  init(events: EventSink) {
    self.events = events
    let (stream, input) = AsyncStream.makeStream(of: Command.self)
    self.input = input
    Task { await self.run(stream) }
  }

  func apply(_ settings: VadSettings) {
    self.settings = settings
    segmentation = VadSegmentationConfig(
      minSilenceDuration: settings.minSilenceSeconds,
      maxSpeechDuration: max(14, settings.minSilenceSeconds))
    if let vadModel {
      vad = VadManager(config: VadConfig(defaultThreshold: settings.threshold), vadModel: vadModel)
    }
  }

  func load(_ config: VoiceConfig) async throws {
    if vadModel == nil {
      let models = try await ModelHub.loadModels(
        .vad, modelNames: Array(ModelNames.VAD.requiredModels), directory: ModelStore.root)
      guard let model = models[ModelNames.VAD.sileroVadFile] else { throw VoiceModeError.modelsMissing }
      vadModel = model
    }
    apply(config.vad)
    guard asr == nil || asrChunk != config.chunkSize || asrDebounceMs != config.eouDebounceMs else { return }
    let manager = StreamingEouAsrManager(chunkSize: config.chunkSize, eouDebounceMs: config.eouDebounceMs)
    try await manager.loadModels(to: ModelStore.root)
    let events = self.events
    await manager.setPartialCallback { text in events.send("partial", ["text": text]) }
    await manager.setEouCallback { text in
      events.stage("eou")
      events.send("eou", ["text": text])
    }
    await asr?.cleanup()
    asr = manager
    asrChunk = config.chunkSize
    asrDebounceMs = config.eouDebounceMs
  }

  func unload() async {
    await asr?.cleanup()
    asr = nil
    vad = nil
    vadModel = nil
  }

  nonisolated func finalize() async throws -> String {
    try await withCheckedThrowingContinuation { input.yield(.finalize($0)) }
  }

  private func run(_ stream: AsyncStream<Command>) async {
    for await command in stream {
      switch command {
      case .audio(let buffer): await hear(buffer)
      case .reset: await reset()
      case .finalize(let reply): await finalize(reply)
      }
    }
  }

  private func hear(_ buffer: AVAudioPCMBuffer) async {
    guard let asr, let vad, let channel = buffer.floatChannelData?[0] else { return }
    pending.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    while pending.count >= VadManager.chunkSize {
      let chunk = Array(pending.prefix(VadManager.chunkSize))
      pending.removeFirst(VadManager.chunkSize)
      do {
        let result = try await vad.processStreamingChunk(chunk, state: vadState, config: segmentation)
        vadState = result.state
        track(result)
      } catch {
        events.error("vad_failed", error)
      }
    }
    do {
      try await asr.appendAudio(buffer)
      try await asr.processBufferedAudio()
      // A confirmed end latches until rearmed; rearming keeps the transcript and replays the audio since.
      if await asr.eouDetected { try await asr.rearm(keepTranscript: true) }
    } catch {
      events.error("asr_failed", error)
    }
  }

  private func track(_ result: VadStreamResult) {
    if let event = result.event {
      if event.isStart {
        speechStart = event.sampleIndex
      } else if event.isEnd {
        if reported { emitVad(false, result.probability) }
        speechStart = nil
        reported = false
      }
    }
    if let start = speechStart, !reported, result.state.processedSamples - start >= settings.minSpeechSamples {
      reported = true
      emitVad(true, result.probability)
    }
  }

  private func emitVad(_ speaking: Bool, _ probability: Float) {
    events.stage(speaking ? "vad.start" : "vad.end")
    events.send("vad", ["speaking": speaking, "probability": Double(probability), "atMs": nowMs()])
  }

  private func reset() async {
    await asr?.reset()
    if reported { emitVad(false, 0) }
    vadState = VadStreamState.initial()
    pending.removeAll()
    speechStart = nil
    reported = false
  }

  private func finalize(_ reply: CheckedContinuation<String, Error>) async {
    guard let asr else { return reply.resume(returning: "") }
    events.stage("finalize.start")
    do {
      let text = try await asr.finish()
      await asr.reset()
      events.stage("finalize.end")
      reply.resume(returning: text)
    } catch {
      reply.resume(throwing: error)
    }
  }
}
