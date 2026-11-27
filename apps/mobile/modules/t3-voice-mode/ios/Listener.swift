import Accelerate
import Foundation

/// Silero on every 32 ms frame of the mic, in arrival order, with the hold rule deciding when
/// speech starts and ends. The mic tap stores the audio in the ring first, so a `vad` event's
/// range is always readable by the time JS hears about it.
actor Listener {
  enum Command {
    case audio([Float], start: Int)
    case reset
  }

  nonisolated let input: AsyncStream<Command>.Continuation
  private let events: EventSink
  private let ring: AudioRing
  private var vad: SileroVad?
  private var gate = SpeechGate(settings: .init(threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300))
  private var pending: [Float] = []
  private var pendingStart = 0
  private var failing = false

  init(events: EventSink, ring: AudioRing) {
    self.events = events
    self.ring = ring
    let (stream, input) = AsyncStream.makeStream(of: Command.self)
    self.input = input
    Task { await self.run(stream) }
  }

  func apply(_ settings: SpeechGate.Settings) {
    gate.settings = settings
  }

  func load() throws {
    guard vad == nil else { return }
    vad = try SileroVad.load()
  }

  func unload() {
    vad = nil
  }

  private func run(_ stream: AsyncStream<Command>) async {
    for await command in stream {
      switch command {
      case .audio(let samples, let start): hear(samples, start: start)
      case .reset: reset()
      }
    }
  }

  private func hear(_ samples: [Float], start: Int) {
    guard let vad else { return }
    if pending.isEmpty { pendingStart = start }
    pending.append(contentsOf: samples)
    let frame = SileroVad.frameSamples
    var offset = 0
    while pending.count - offset >= frame {
      let window = pending[offset..<offset + frame]
      offset += frame
      do {
        let probability = try vad.probability(window)
        failing = false
        let energy = window.withUnsafeBufferPointer { Double(vDSP.sumOfSquares($0)) }
        let change = gate.push(
          start: pendingStart + offset - frame, count: frame, probability: probability, energy: energy)
        if let change { emit(change) }
      } catch {
        if !failing { events.error("vad_failed", error) }
        failing = true
      }
    }
    pending.removeFirst(offset)
    pendingStart += offset
  }

  private func reset() {
    if let change = gate.reset() { emit(change) }
    vad?.reset()
    pending.removeAll()
    failing = false
  }

  private func emit(_ change: SpeechGate.Change) {
    events.stage(change.speaking ? "vad.start" : "vad.end")
    events.send("vad", [
      "speaking": change.speaking, "probability": Double(change.probability), "level": Double(change.level),
      "atMs": ring.ms(at: change.sample),
    ])
  }
}
