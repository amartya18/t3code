import AVFoundation
@_implementationOnly import FluidAudio
import Foundation

/// Kokoro synthesis in call order onto a player node in the voice engine's graph, so the echo
/// canceller hears what we play. Every accepted item ends with one `finished` or `stopped` event.
actor Speaker {
  private struct Item {
    let id: String
    let seq: Int
  }

  static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

  private let events: EventSink
  private let controls: Controls
  private var tts: KokoroAneManager?
  private var ttsFloat32: Bool?
  private var voice = ""
  private var speed: Float = 1
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var live: [Item] = []
  private var playing: [String] = []
  private var tasks: [String: Task<Error?, Never>] = [:]
  private var tail: Task<Error?, Never>?

  init(events: EventSink, controls: Controls) {
    self.events = events
    self.controls = controls
  }

  func apply(_ config: VoiceConfig) {
    voice = config.voiceId
    speed = config.speed
  }

  func load(_ config: VoiceConfig) async throws {
    apply(config)
    guard tts == nil || ttsFloat32 != config.vocoderFloat32 else { return }
    let manager = KokoroAneManager(
      variant: .english, directory: ModelStore.root,
      vocoderPrecision: config.vocoderFloat32 ? .float32 : .float16)
    try await manager.initialize(preloadVoices: [config.voiceId])
    await tts?.cleanup()
    tts = manager
    ttsFloat32 = config.vocoderFloat32
  }

  func unload() async {
    await tts?.cleanup()
    tts = nil
    ttsFloat32 = nil
  }

  func synthesize(_ text: String) async throws -> KokoroAneSynthesisResult {
    guard let tts else { throw VoiceModeError.modelsMissing }
    return try await tts.synthesizeDetailed(text: text, voice: voice, speed: speed)
  }

  /// A new graph after a route change or interruption: what played on the old one is gone, queued items carry over.
  func attach(_ engine: AVAudioEngine?) {
    let lost = playing
    playing = []
    if let player, let old = self.engine {
      player.stop()
      old.detach(player)
    }
    self.engine = engine
    player = makePlayer()
    for id in lost { finish(id, "stopped") }
  }

  func stopAll() {
    for item in live { tasks[item.id]?.cancel() }
    let all = live.map(\.id)
    attach(nil)
    for id in all { finish(id, "stopped") }
  }

  func speak(id: String, text: String, seq: Int) async throws {
    guard engine != nil else { throw VoiceModeError.notStarted }
    guard seq >= controls.stopBefore else { return events.playback(id, "stopped") }
    live.append(Item(id: id, seq: seq))
    let previous = tail
    let task = Task {
      _ = await previous?.value
      return await self.render(id: id, text: text)
    }
    tail = task
    tasks[id] = task
    let failure = await task.value
    tasks[id] = nil
    if let failure { throw failure }
  }

  func stop(fadeMs: Double, seq: Int) {
    let doomed = Set(live.filter { $0.seq < seq }.map(\.id))
    guard !doomed.isEmpty else { return }
    for id in doomed { tasks[id]?.cancel() }
    if playing.contains(where: doomed.contains), let old = player, let engine {
      let lost = playing
      playing = []
      player = makePlayer()
      Task { await self.fadeOut(old, from: engine, fadeMs: fadeMs) }
      for id in lost where !doomed.contains(id) { finish(id, "stopped") }
    }
    for id in doomed { finish(id, "stopped") }
  }

  func applyVolume() {
    player?.volume = controls.volume
  }

  private func makePlayer() -> AVAudioPlayerNode? {
    guard let engine else { return nil }
    let node = AVAudioPlayerNode()
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: Self.format)
    node.volume = controls.volume
    if engine.isRunning { node.play() }
    return node
  }

  private func render(id: String, text: String) async -> Error? {
    guard isLive(id) else { return nil }
    guard let tts else {
      finish(id, "stopped")
      return VoiceModeError.modelsMissing
    }
    events.stage("synth.start:\(id)")
    do {
      let result = try await tts.synthesizeDetailed(text: text, voice: voice, speed: speed)
      events.stage("synth.end:\(id)")
      guard isLive(id) else { return nil }
      try schedule(id, result)
      return nil
    } catch {
      guard isLive(id) else { return nil }
      finish(id, "stopped")
      events.error("synth_failed", error)
      return error
    }
  }

  private func schedule(_ id: String, _ result: KokoroAneSynthesisResult) throws {
    guard let player, let engine else { return finish(id, "stopped") }
    guard result.sampleRate == Int(Self.format.sampleRate) else {
      throw VoiceModeError.make("bad_audio", "Kokoro returned \(result.sampleRate) Hz audio.")
    }
    let samples = result.samples
    guard !samples.isEmpty,
      let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = buffer.floatChannelData?[0]
    else { return finish(id, "finished") }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      Task { await self?.played(id, on: player) }
    }
    if playing.isEmpty { started(id) }
    playing.append(id)
    // play() raises an Objective-C exception when the system has stopped the engine.
    if !player.isPlaying, engine.isRunning { player.play() }
  }

  private func played(_ id: String, on node: AVAudioPlayerNode) {
    guard node === player, playing.first == id else { return }
    playing.removeFirst()
    events.stage("play.end:\(id)")
    finish(id, "finished")
    if let next = playing.first { started(next) }
  }

  private func started(_ id: String) {
    events.stage("play.start:\(id)")
    events.playback(id, "started")
  }

  private func finish(_ id: String, _ state: String) {
    guard let index = live.firstIndex(where: { $0.id == id }) else { return }
    live.remove(at: index)
    events.playback(id, state)
  }

  private func isLive(_ id: String) -> Bool {
    live.contains { $0.id == id }
  }

  private func fadeOut(_ node: AVAudioPlayerNode, from engine: AVAudioEngine, fadeMs: Double) async {
    let steps = max(1, Int(fadeMs / 10))
    let start = node.volume
    for step in 1...steps where fadeMs > 0 {
      node.volume = start * Float(steps - step) / Float(steps)
      try? await Task.sleep(nanoseconds: UInt64(fadeMs / Double(steps) * 1_000_000))
    }
    node.stop()
    engine.detach(node)
  }
}
