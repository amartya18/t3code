import CoreML
import Foundation

/// Smart Turn v3.2 (pipecat-ai/smart-turn-v3, Core ML conversion aufklarer/Smart-Turn-v3.2-CoreML).
/// The Whisper log-mel front end and its waveform normalisation are inside the model, so it takes
/// the last 8 s of raw 16 kHz audio, zero-padded at the front as upstream trained it.
actor TurnDetector {
  static let windowSamples = 128_000

  private var model: MLModel?
  private var window: MLMultiArray?

  func load() throws {
    guard model == nil else { return }
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .cpuAndNeuralEngine
    model = try MLModel(contentsOf: ModelStore.turnModel, configuration: configuration)
    window = try MLMultiArray(shape: [1, NSNumber(value: Self.windowSamples)], dataType: .float32)
  }

  func unload() {
    model = nil
    window = nil
  }

  func probability(_ samples: [Float]) throws -> Float {
    guard let model, let window else { throw VoiceModeError.notStarted }
    let tail = samples.suffix(Self.windowSamples)
    let pointer = window.dataPointer.assumingMemoryBound(to: Float.self)
    let padding = Self.windowSamples - tail.count
    pointer.update(repeating: 0, count: padding)
    tail.withUnsafeBufferPointer { source in
      guard let base = source.baseAddress else { return }
      pointer.advanced(by: padding).update(from: base, count: source.count)
    }
    let output = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["audio": window]))
    return try outputFloats(output, "probability", count: 1)[0]
  }
}
