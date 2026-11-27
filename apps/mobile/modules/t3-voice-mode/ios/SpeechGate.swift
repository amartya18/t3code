import Foundation

/// The hold rule on per-frame speech probabilities: speech starts once voiced frames have lasted
/// `minSpeechMs` and ends once unvoiced frames have lasted `minSilenceMs`. Positions are sample
/// indices, and a change carries the sample where its run began: the real start or end of speech.
struct SpeechGate {
  struct Settings: Equatable {
    let threshold: Float
    let minSpeechMs: Double
    let minSilenceMs: Double
  }

  struct Change: Equatable {
    let speaking: Bool
    let sample: Int
    let probability: Float
    let level: Float
  }

  private struct Run {
    var start = 0
    var samples = 0
    var probability: Float = 0
    var frames = 0
    var energy: Double = 0
  }

  var settings: Settings
  private(set) var speaking = false
  private var run = Run()
  private var processedEnd = 0

  init(settings: Settings) {
    self.settings = settings
  }

  /// `energy` is the frame's sum of squared samples.
  mutating func push(start: Int, count: Int, probability: Float, energy: Double) -> Change? {
    processedEnd = start + count
    guard (probability >= settings.threshold) != speaking else {
      run = Run()
      return nil
    }
    if run.frames == 0 { run.start = start }
    run.samples += count
    run.frames += 1
    run.probability += probability
    run.energy += energy
    let holdMs = speaking ? settings.minSilenceMs : settings.minSpeechMs
    guard Double(run.samples) >= holdMs * AudioRing.samplesPerMs else { return nil }
    speaking.toggle()
    return finish(at: run.start)
  }

  /// Ends speech in progress at the last voiced frame and forgets every run.
  mutating func reset() -> Change? {
    defer {
      speaking = false
      run = Run()
    }
    guard speaking else { return nil }
    speaking = false
    return finish(at: run.frames > 0 ? run.start : processedEnd)
  }

  private mutating func finish(at sample: Int) -> Change {
    let frames = Float(max(run.frames, 1))
    let level = run.samples > 0 ? (run.energy / Double(run.samples)).squareRoot() : 0
    let change = Change(
      speaking: speaking, sample: sample, probability: run.probability / frames, level: Float(min(level, 1)))
    run = Run()
    return change
  }
}
