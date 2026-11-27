import AVFoundation
import Foundation

/// One AVAudioEngine for the mic and the voice, so Apple's voice processing cancels our own speech.
actor VoiceEngine {
  nonisolated let events: EventSink
  nonisolated let controls: Controls
  nonisolated let ring: AudioRing
  let listener: Listener
  let transcriber = Transcriber()
  let turn = TurnDetector()
  let speaker: Speaker
  private(set) var config: VoiceConfig?
  private var audio: AVAudioEngine?
  private var running = false
  private var downloading = false
  private var sessionObservers: [NSObjectProtocol] = []
  private var engineObserver: NSObjectProtocol?
  private var stopping: Task<Void, Never>?
  private var restarting = false

  init() {
    let events = EventSink()
    let controls = Controls()
    let ring = AudioRing(seconds: 60)
    self.events = events
    self.controls = controls
    self.ring = ring
    listener = Listener(events: events, ring: ring)
    speaker = Speaker(events: events, controls: controls)
  }

  func configure(_ config: VoiceConfig) async {
    self.config = config
    events.setLogStages(config.logStages)
    await listener.apply(config.vad)
    await speaker.apply(config)
  }

  func requireConfig() throws -> VoiceConfig {
    guard let config else { throw VoiceModeError.notConfigured }
    return config
  }

  func modelStatus() throws -> [String: Any] {
    ModelStore.status(try requireConfig())
  }

  func downloadModels() async throws {
    let config = try requireConfig()
    guard !downloading else { throw VoiceModeError.busy }
    downloading = true
    defer { downloading = false }
    let progress = DownloadProgressEvents(events)
    do {
      try await ModelStore.download(config) { part, fraction in progress.report(part, fraction) }
      progress.finish("ready")
    } catch {
      progress.finish("failed")
      throw error
    }
  }

  func deleteModels() async throws {
    guard !running, !downloading else { throw VoiceModeError.busy }
    await listener.unload()
    await transcriber.unload()
    await turn.unload()
    await speaker.unload()
    try ModelStore.delete()
  }

  func start() async throws {
    await stopping?.value
    guard !running else { return }
    let config = try requireConfig()
    running = true
    do {
      guard await AVAudioApplication.requestRecordPermission() else { throw VoiceModeError.permissionDenied }
      guard ModelStore.isReady(config) else { throw VoiceModeError.modelsMissing }
      events.stage("load.start")
      async let heard: Void = listener.load()
      async let written: Void = transcriber.load()
      async let turned: Void = turn.load()
      async let spoken: Void = speaker.load(config)
      _ = try await (heard, written, turned, spoken)
      events.stage("load.end")
      guard running else { return }
      ring.clear()
      listener.input.yield(.reset)
      try activateSession(config)
      try await buildAudio(config)
      observeSession()
    } catch {
      await stop()
      throw error
    }
  }

  func stop() async {
    guard running else {
      await stopping?.value
      return
    }
    running = false
    for observer in sessionObservers { NotificationCenter.default.removeObserver(observer) }
    sessionObservers.removeAll()
    let task = Task {
      await self.teardownAudio()
      await self.speaker.stopAll()
      self.listener.input.yield(.reset)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    stopping = task
    await task.value
    stopping = nil
  }

  func setVocabulary(_ words: [String]) async throws {
    try await transcriber.setVocabulary(words)
  }

  func transcribe(fromMs: Double, toMs: Double) async throws -> String {
    let samples = ring.samples(fromMs: fromMs, toMs: toMs)
    events.stage("transcribe.start")
    defer { events.stage("transcribe.end") }
    return try await transcriber.transcribe(samples)
  }

  func turnScore(fromMs: Double, toMs: Double) async throws -> Float {
    try await turn.probability(ring.samples(fromMs: fromMs, toMs: toMs))
  }

  func speak(id: String, text: String, seq: Int) async throws {
    try await speaker.speak(id: id, text: text, seq: seq)
  }

  nonisolated func setMuted(_ muted: Bool) {
    controls.muted = muted
    Task { await self.applyMute() }
  }

  nonisolated func duck(_ level: Double) {
    controls.volume = Float(min(max(level, 0), 1))
    Task { await self.speaker.applyVolume() }
  }

  nonisolated func stopSpeech(fadeMs: Double, seq: Int) {
    controls.stop(before: seq)
    Task { await self.speaker.stop(fadeMs: max(0, fadeMs), seq: seq) }
  }

  private func applyMute() {
    guard let input = audio?.inputNode, input.isVoiceProcessingEnabled else { return }
    input.isVoiceProcessingInputMuted = controls.muted
  }

  private func activateSession(_ config: VoiceConfig) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord, mode: config.aec ? .voiceChat : .default,
      options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setActive(true)
  }

  private func buildAudio(_ config: VoiceConfig) async throws {
    let engine = AVAudioEngine()
    // Voice processing must be switched on while the engine is stopped, before reading the input format.
    if config.aec { try engine.inputNode.setVoiceProcessingEnabled(true) }
    try await run(engine, aec: config.aec)
    audio = engine
    engineObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      Task { await self?.engineConfigurationChanged(engine) }
    }
    events.stage("mic.start")
    emitRoute()
  }

  /// Taps the mic in its current format and starts the engine. Right after a route change or
  /// voice processing reconfigures the session, the input can read 0 Hz for a moment, so wait it out.
  private func run(_ engine: AVAudioEngine, aec: Bool) async throws {
    let input = engine.inputNode
    input.removeTap(onBus: 0)
    var format = input.outputFormat(forBus: 0)
    for _ in 0..<20 where format.sampleRate == 0 || format.channelCount == 0 {
      try await Task.sleep(nanoseconds: 100_000_000)
      format = input.outputFormat(forBus: 0)
    }
    guard format.sampleRate > 0, format.channelCount > 0, let mic = MicConverter(from: format) else {
      throw VoiceModeError.noInput
    }
    let controls = self.controls
    let ring = self.ring
    let sink = listener.input
    let sampleRate = format.sampleRate
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, when in
      guard let samples = mic.convert(buffer, silence: controls.muted) else { return }
      let capturedMs =
        when.isHostTimeValid ? hostMs(when.hostTime) : nowMs() - Double(buffer.frameLength) / sampleRate * 1000
      sink.yield(.audio(samples, start: ring.append(samples, atMs: capturedMs)))
    }
    if aec { input.isVoiceProcessingInputMuted = controls.muted }
    await speaker.attach(engine)
    engine.prepare()
    try engine.start()
  }

  private func teardownAudio() async {
    if let engineObserver { NotificationCenter.default.removeObserver(engineObserver) }
    engineObserver = nil
    guard let engine = audio else { return }
    audio = nil
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    await speaker.attach(nil)
  }

  private func recover() async {
    guard running, let config else { return }
    await teardownAudio()
    do {
      try activateSession(config)
      try await buildAudio(config)
    } catch {
      events.error("engine_restart_failed", error)
    }
  }

  /// The engine stops itself when its I/O format changes, for example on a new route or when voice
  /// processing reconfigures the session. A new engine then reads a 0 Hz mic, so restart this one
  /// once iOS settles, and rebuild only if that keeps failing.
  private func engineConfigurationChanged(_ engine: AVAudioEngine) async {
    guard engine === audio, running, !restarting else { return }
    restarting = true
    defer { restarting = false }
    for attempt in 1...3 {
      try? await Task.sleep(nanoseconds: UInt64(attempt) * 250_000_000)
      guard engine === audio, running, let config else { return }
      if engine.isRunning { return emitRoute() }
      do {
        try activateSession(config)
        try await run(engine, aec: config.aec)
        events.stage("mic.restart")
        return emitRoute()
      } catch {
        events.stage("mic.restart_failed:\(attempt)")
      }
    }
    await recover()
  }

  private func observeSession() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    sessionObservers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) {
        [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        Task { await self?.interrupted(began: type == .began) }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) {
        [weak self] _ in
        Task { await self?.emitRoute() }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) {
        [weak self] _ in
        Task { await self?.recover() }
      },
    ]
  }

  private func interrupted(began: Bool) async {
    events.send("interruption", ["phase": began ? "began" : "ended"])
    if began { return }
    guard let engine = audio else { return await recover() }
    await engineConfigurationChanged(engine)
  }

  private func emitRoute() {
    let output = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "none"
    events.send("route", ["output": output])
  }
}

/// Converts the mic's native format to the 16 kHz mono Float32 that Parakeet and Silero take.
/// One converter for the whole session keeps the resampler's filter state across buffers.
final class MicConverter: @unchecked Sendable {
  static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  private let converter: AVAudioConverter
  private let ratio: Double

  init?(from input: AVAudioFormat) {
    guard let converter = AVAudioConverter(from: input, to: Self.format) else { return nil }
    converter.downmix = true
    self.converter = converter
    ratio = Self.format.sampleRate / input.sampleRate
  }

  func convert(_ buffer: AVAudioPCMBuffer, silence: Bool) -> [Float]? {
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: capacity) else { return nil }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if supplied {
        state.pointee = .noDataNow
        return nil
      }
      supplied = true
      state.pointee = .haveData
      return buffer
    }
    guard status != .error, output.frameLength > 0, let channel = output.floatChannelData?[0] else { return nil }
    let count = Int(output.frameLength)
    return silence ? [Float](repeating: 0, count: count) : Array(UnsafeBufferPointer(start: channel, count: count))
  }
}

/// Sends `models` progress once per whole percent per part, never going back within a part, so a
/// download doesn't flood the bridge and FluidAudio's per-file restarts don't rewind the bar.
final class DownloadProgressEvents: @unchecked Sendable {
  private let lock = NSLock()
  private let events: EventSink
  private var last: (String, Int)?

  init(_ events: EventSink) {
    self.events = events
  }

  func report(_ part: String, _ fraction: Double) {
    let percent = Int(fraction * 100)
    let changed = lock.withLock { () -> Bool in
      if let last, last.0 == part, percent <= last.1 { return false }
      last = (part, percent)
      return true
    }
    guard changed else { return }
    send("downloading", part: part, fraction: Double(percent) / 100)
  }

  func finish(_ state: String) {
    send(state, part: nil, fraction: state == "ready" ? 1 : 0)
  }

  private func send(_ state: String, part: String?, fraction: Double) {
    events.send("models", [
      "state": state, "part": part.map { $0 as Any } ?? NSNull(), "fraction": fraction, "bytesOnDisk": ModelStore.bytesOnDisk(),
    ])
  }
}
