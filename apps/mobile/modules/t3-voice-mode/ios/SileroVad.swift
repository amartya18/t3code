import CoreML
import Foundation

/// Silero v6 on single 32 ms frames: 512 new samples after the previous frame's last 64, with the
/// LSTM state carried from frame to frame. Not thread-safe; each owner keeps its own.
final class SileroVad {
  static let frameSamples = 512
  static let contextSamples = 64
  private static let stateSize = 128

  private let model: MLModel
  private let audio: MLMultiArray
  private let hidden: MLMultiArray
  private let cell: MLMultiArray
  private let inputs: MLFeatureProvider

  init(model: MLModel) throws {
    self.model = model
    audio = try MLMultiArray(shape: [1, NSNumber(value: Self.contextSamples + Self.frameSamples)], dataType: .float32)
    hidden = try MLMultiArray(shape: [1, NSNumber(value: Self.stateSize)], dataType: .float32)
    cell = try MLMultiArray(shape: [1, NSNumber(value: Self.stateSize)], dataType: .float32)
    inputs = try MLDictionaryFeatureProvider(dictionary: ["audio_input": audio, "hidden_state": hidden, "cell_state": cell])
    reset()
  }

  static func load() throws -> SileroVad {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .cpuOnly
    return try SileroVad(model: MLModel(contentsOf: ModelStore.vadModel, configuration: configuration))
  }

  func reset() {
    for array in [audio, hidden, cell] {
      array.dataPointer.assumingMemoryBound(to: Float.self).update(repeating: 0, count: array.count)
    }
  }

  func probability(_ frame: ArraySlice<Float>) throws -> Float {
    precondition(frame.count == Self.frameSamples)
    let window = audio.dataPointer.assumingMemoryBound(to: Float.self)
    window.update(from: window.advanced(by: Self.frameSamples), count: Self.contextSamples)
    frame.withUnsafeBufferPointer { window.advanced(by: Self.contextSamples).update(from: $0.baseAddress!, count: $0.count) }
    let output = try model.prediction(from: inputs)
    try copy(output, "new_hidden_state", into: hidden)
    try copy(output, "new_cell_state", into: cell)
    return try outputFloats(output, "vad_output", count: 1)[0]
  }

  private func copy(_ output: MLFeatureProvider, _ name: String, into state: MLMultiArray) throws {
    let values = try outputFloats(output, name, count: Self.stateSize)
    state.dataPointer.assumingMemoryBound(to: Float.self).update(from: values, count: Self.stateSize)
  }
}

/// Reads a Core ML output as Float32 whatever precision the runtime handed back.
func outputFloats(_ output: MLFeatureProvider, _ name: String, count: Int) throws -> [Float] {
  guard let array = output.featureValue(for: name)?.multiArrayValue, array.count >= count else {
    throw VoiceModeError.make("model_output", "Core ML returned no \(name).")
  }
  if array.dataType == .float32, array.strides.last?.intValue == 1 {
    return Array(UnsafeBufferPointer(start: array.dataPointer.assumingMemoryBound(to: Float.self), count: count))
  }
  return (0..<count).map { array[$0].floatValue }
}
