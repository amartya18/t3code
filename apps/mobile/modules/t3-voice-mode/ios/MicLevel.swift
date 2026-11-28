import Accelerate
import Foundation

/// The mic's raw loudness for the call's wave: the RMS of each ~32 ms window of 16 kHz audio, so
/// a 100 ms tap buffer gives three. JS smooths and scales it; nothing here filters.
enum MicLevel {
  static let windowSamples = 512

  /// Equal windows of about `windowSamples` each, timed from `atMs`, the first sample's time.
  static func windows(_ samples: [Float], atMs: Double) -> [(level: Float, atMs: Double)] {
    guard !samples.isEmpty else { return [] }
    let count = max(1, (samples.count + windowSamples / 2) / windowSamples)
    return (0..<count).map { index -> (level: Float, atMs: Double) in
      let start = samples.count * index / count
      let end = samples.count * (index + 1) / count
      let level = samples[start..<end].withUnsafeBufferPointer { vDSP.rootMeanSquare($0) }
      return (level: level, atMs: atMs + Double(start) / AudioRing.samplesPerMs)
    }
  }
}
